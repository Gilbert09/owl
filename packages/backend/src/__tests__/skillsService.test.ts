import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SKILL_MAX_BYTES } from '@talyn/shared';
import {
  listRepoSkills,
  getRepoSkillContent,
  getSkillUsage,
  bumpSkillUsage,
  clearRepoSkillCache,
  CONTENT_CONCURRENCY,
} from '../services/skills.js';
import { githubService } from '../services/github.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
} from '../db/schema.js';

vi.mock('../services/github.js', () => ({
  githubService: {
    getDirectoryListing: vi.fn(),
    getDirectoryListingResolved: vi.fn(),
    getTreeRecursive: vi.fn(),
    getFileContent: vi.fn(),
  },
}));

const mockResolved = vi.mocked(githubService.getDirectoryListingResolved);
const mockListing = vi.mocked(githubService.getDirectoryListing);
const mockTree = vi.mocked(githubService.getTreeRecursive);
const mockContent = vi.mocked(githubService.getFileContent);

const SKILL_MD = '---\nname: reviewer\ndescription: Reviews PRs\n---\n\nReview carefully.';

function rootEntry(name: string, type: 'file' | 'dir' | 'symlink' = 'dir', size = 0) {
  return { name, path: `.claude/skills/${name}`, type, size };
}

function blob(path: string, sha: string, size = SKILL_MD.length) {
  return { path, sha, size, type: 'blob' as const, mode: '100644' };
}

/**
 * Wire the tree path: `.claude/skills` is a real dir holding one skill,
 * `reviewer`, with a SKILL.md and a helper file.
 */
function mockTreePath() {
  mockResolved.mockResolvedValue({
    path: '.claude/skills',
    entries: [rootEntry('reviewer'), rootEntry('README.md', 'file')],
  });
  mockTree.mockResolvedValue({
    truncated: false,
    entries: [
      blob('reviewer/SKILL.md', 'sha-reviewer'),
      blob('reviewer/checklist.md', 'sha-checklist', 10),
    ],
  });
  mockContent.mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });
}

/** Wire the walk fallback: the tree is unavailable, so each dir is listed. */
function mockWalkPath() {
  mockResolved.mockResolvedValue({
    path: '.claude/skills',
    entries: [rootEntry('reviewer'), rootEntry('README.md', 'file')],
  });
  mockTree.mockResolvedValue(null);
  mockListing.mockImplementation(async (_ws, _o, _r, path) => {
    if (path === '.claude/skills/reviewer') {
      return [
        { name: 'SKILL.md', path: '.claude/skills/reviewer/SKILL.md', type: 'file', size: 70 },
        { name: 'checklist.md', path: '.claude/skills/reviewer/checklist.md', type: 'file', size: 10 },
      ];
    }
    return null;
  });
  mockContent.mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });
}

describe('skills service', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    clearRepoSkillCache();
    mockResolved.mockReset();
    mockListing.mockReset();
    mockTree.mockReset();
    mockContent.mockReset();
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'develop',
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('listRepoSkills', () => {
    it('discovers skills with frontmatter metadata and supporting-files flag', async () => {
      mockTreePath();
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.status).toBe('ok');
      expect(result.skills).toHaveLength(1);
      const skill = result.skills[0];
      expect(skill.name).toBe('reviewer');
      expect(skill.description).toBe('Reviews PRs');
      expect(skill.key).toBe('repo:acme/widgets:reviewer');
      expect(skill.repoPath).toBe('.claude/skills/reviewer/SKILL.md');
      expect(skill.hasSupportingFiles).toBe(true);
      expect(skill.content).toBe(SKILL_MD);
      // No ref on purpose: the stored defaultBranch is unreliable (hardcoded
      // 'main' at addWatchedRepo) — GitHub resolves the real default branch.
      expect(mockResolved).toHaveBeenCalledWith('ws1', 'acme', 'widgets', '.claude/skills', undefined);
    });

    it('finds every skill with ONE tree call, not one listing per directory', async () => {
      const names = Array.from({ length: 40 }, (_, i) => `skill-${i}`);
      mockResolved.mockResolvedValue({
        path: '.agents/skills',
        entries: names.map((n) => rootEntry(n)),
      });
      mockTree.mockResolvedValue({
        truncated: false,
        entries: names.map((n, i) => blob(`${n}/SKILL.md`, `sha-${i}`)),
      });
      mockContent.mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });

      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.skills).toHaveLength(40);
      expect(mockTree).toHaveBeenCalledTimes(1);
      expect(mockTree).toHaveBeenCalledWith('ws1', 'acme', 'widgets', 'HEAD:.agents/skills');
      expect(mockListing).not.toHaveBeenCalled();
      // Paths are rooted at the RESOLVED dir — posthog/posthog's
      // `.claude/skills` is a symlink to `.agents/skills`.
      expect(result.skills[0].repoPath).toBe('.agents/skills/skill-0/SKILL.md');
    });

    it('keeps content reads under the concurrency bound', async () => {
      const names = Array.from({ length: 40 }, (_, i) => `skill-${i}`);
      mockResolved.mockResolvedValue({
        path: '.claude/skills',
        entries: names.map((n) => rootEntry(n)),
      });
      mockTree.mockResolvedValue({
        truncated: false,
        entries: names.map((n, i) => blob(`${n}/SKILL.md`, `sha-${i}`)),
      });
      let inFlight = 0;
      let peak = 0;
      mockContent.mockImplementation(async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { content: SKILL_MD, size: SKILL_MD.length };
      });

      await listRepoSkills('ws1', 'repo1');
      expect(mockContent).toHaveBeenCalledTimes(40);
      expect(peak).toBeLessThanOrEqual(CONTENT_CONCURRENCY);
      expect(peak).toBeGreaterThan(1);
    });

    it('shares the concurrency bound across simultaneous discoveries', async () => {
      await db.insert(repositoriesTable).values({
        id: 'repo2',
        workspaceId: 'ws1',
        name: 'acme/gadgets',
        url: 'https://github.com/acme/gadgets',
        defaultBranch: 'main',
      });
      const names = Array.from({ length: 30 }, (_, i) => `skill-${i}`);
      mockResolved.mockResolvedValue({
        path: '.claude/skills',
        entries: names.map((n) => rootEntry(n)),
      });
      mockTree.mockResolvedValue({
        truncated: false,
        entries: names.map((n, i) => blob(`${n}/SKILL.md`, `sha-${i}`)),
      });
      let live = 0;
      let peak = 0;
      mockContent.mockImplementation(async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 1));
        live--;
        return { content: SKILL_MD, size: SKILL_MD.length };
      });

      // The desktop prefetches every watched repo at once — a per-call bound
      // would just multiply by the repo count.
      await Promise.all([listRepoSkills('ws1', 'repo1'), listRepoSkills('ws1', 'repo2')]);
      expect(mockContent).toHaveBeenCalledTimes(60);
      expect(peak).toBeLessThanOrEqual(CONTENT_CONCURRENCY);
    });

    it('re-reads only the SKILL.md whose blob sha moved', async () => {
      mockResolved.mockResolvedValue({
        path: '.claude/skills',
        entries: [rootEntry('a'), rootEntry('b')],
      });
      mockTree.mockResolvedValue({
        truncated: false,
        entries: [blob('a/SKILL.md', 'sha-a'), blob('b/SKILL.md', 'sha-b')],
      });
      mockContent.mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });
      await listRepoSkills('ws1', 'repo1');
      expect(mockContent).toHaveBeenCalledTimes(2);

      mockTree.mockResolvedValue({
        truncated: false,
        entries: [blob('a/SKILL.md', 'sha-a'), blob('b/SKILL.md', 'sha-b-v2')],
      });
      const refreshed = await listRepoSkills('ws1', 'repo1', { refresh: true });
      expect(mockContent).toHaveBeenCalledTimes(3);
      expect(mockContent).toHaveBeenLastCalledWith(
        'ws1', 'acme', 'widgets', '.claude/skills/b/SKILL.md', undefined, SKILL_MAX_BYTES
      );
      expect(refreshed.skills).toHaveLength(2);
      expect(refreshed.skills.every((s) => s.content === SKILL_MD)).toBe(true);
    });

    it('drops cached blobs for skills that no longer exist', async () => {
      mockResolved.mockResolvedValue({ path: '.claude/skills', entries: [rootEntry('a')] });
      mockTree.mockResolvedValue({ truncated: false, entries: [blob('a/SKILL.md', 'sha-a')] });
      mockContent.mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });
      await listRepoSkills('ws1', 'repo1');

      // Skill deleted…
      mockTree.mockResolvedValue({ truncated: false, entries: [] });
      await listRepoSkills('ws1', 'repo1', { refresh: true });
      // …then restored at the same sha: its content must be read again.
      mockTree.mockResolvedValue({ truncated: false, entries: [blob('a/SKILL.md', 'sha-a')] });
      await listRepoSkills('ws1', 'repo1', { refresh: true });
      expect(mockContent).toHaveBeenCalledTimes(2);
    });

    it('never sha-caches a symlinked SKILL.md, whose sha tracks the link', async () => {
      mockResolved.mockResolvedValue({ path: '.claude/skills', entries: [rootEntry('linked-file')] });
      mockTree.mockResolvedValue({
        truncated: false,
        entries: [
          { path: 'linked-file/SKILL.md', type: 'blob', mode: '120000', sha: 'sha-link', size: 30 },
        ],
      });
      mockContent.mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });
      await listRepoSkills('ws1', 'repo1');
      await listRepoSkills('ws1', 'repo1', { refresh: true });
      // The link's sha is unchanged, but its target's content may not be.
      expect(mockContent).toHaveBeenCalledTimes(2);
    });

    it('walks directories when the tree is truncated', async () => {
      mockWalkPath();
      mockTree.mockResolvedValue({ truncated: true, entries: [] });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].hasSupportingFiles).toBe(true);
      expect(mockListing).toHaveBeenCalledWith('ws1', 'acme', 'widgets', '.claude/skills/reviewer', undefined);
    });

    it('walks directories when the tree call finds nothing to address', async () => {
      mockWalkPath();
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].content).toBe(SKILL_MD);
    });

    it('walks symlinked skill dirs, which the tree cannot follow', async () => {
      mockResolved.mockResolvedValue({
        path: '.claude/skills',
        entries: [rootEntry('linked', 'symlink')],
      });
      mockListing.mockResolvedValue([
        { name: 'SKILL.md', path: 'elsewhere/linked/SKILL.md', type: 'file', size: 70 },
      ]);
      mockContent.mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(mockTree).not.toHaveBeenCalled(); // no real dirs to enumerate
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].repoPath).toBe('elsewhere/linked/SKILL.md');
    });

    it('returns status none when the skills dir is missing (404)', async () => {
      mockResolved.mockResolvedValue(null);
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.status).toBe('none');
      expect(result.skills).toEqual([]);
    });

    it('falls back to the directory name when frontmatter has no name', async () => {
      mockTreePath();
      mockContent.mockResolvedValue({ content: 'no frontmatter here', size: 19 });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.skills[0].name).toBe('reviewer');
      expect(result.skills[0].description).toBe('');
    });

    it('lists an oversized skill without spending a read on it', async () => {
      mockResolved.mockResolvedValue({ path: '.claude/skills', entries: [rootEntry('huge')] });
      mockTree.mockResolvedValue({
        truncated: false,
        entries: [blob('huge/SKILL.md', 'sha-huge', SKILL_MAX_BYTES + 1)],
      });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.skills[0].content).toBeNull();
      expect(result.skills[0].contentSize).toBe(SKILL_MAX_BYTES + 1);
      expect(result.skills[0].name).toBe('huge');
      expect(mockContent).not.toHaveBeenCalled();
    });

    it('still reports an oversized skill the walk found', async () => {
      mockWalkPath();
      mockContent.mockResolvedValue({ content: null, size: SKILL_MAX_BYTES + 1 });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.skills[0].content).toBeNull();
      expect(result.skills[0].contentSize).toBe(SKILL_MAX_BYTES + 1);
    });

    it('skips dirs without a SKILL.md', async () => {
      mockResolved.mockResolvedValue({ path: '.claude/skills', entries: [rootEntry('empty-dir')] });
      mockTree.mockResolvedValue({
        truncated: false,
        entries: [blob('empty-dir/other.md', 'sha-other', 5)],
      });
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.status).toBe('ok');
      expect(result.skills).toEqual([]);
    });

    it('serves from cache within the TTL and re-fetches on refresh', async () => {
      mockTreePath();
      await listRepoSkills('ws1', 'repo1');
      await listRepoSkills('ws1', 'repo1');
      expect(mockTree).toHaveBeenCalledTimes(1);
      await listRepoSkills('ws1', 'repo1', { refresh: true });
      expect(mockTree).toHaveBeenCalledTimes(2);
    });

    it('serves the stale cache when GitHub errors after a good fetch', async () => {
      mockTreePath();
      const first = await listRepoSkills('ws1', 'repo1');
      expect(first.status).toBe('ok');
      mockResolved.mockRejectedValue(new Error('rate limited'));
      const second = await listRepoSkills('ws1', 'repo1', { refresh: true });
      expect(second.status).toBe('ok');
      expect(second.skills).toHaveLength(1);
    });

    it('returns error status when GitHub fails with no cache', async () => {
      mockResolved.mockRejectedValue(new Error('boom'));
      const result = await listRepoSkills('ws1', 'repo1');
      expect(result.status).toBe('error');
      expect(result.skills).toEqual([]);
    });

    it('does not cache an error result', async () => {
      mockResolved.mockRejectedValue(new Error('gated'));
      expect((await listRepoSkills('ws1', 'repo1')).status).toBe('error');
      mockTreePath();
      // No refresh flag: a cached error would keep the picker broken for the
      // rest of the TTL, long after the rate-limit gate cleared.
      const retried = await listRepoSkills('ws1', 'repo1');
      expect(retried.status).toBe('ok');
      expect(retried.skills).toHaveLength(1);
    });

    it('returns error for an unknown or cross-workspace repository', async () => {
      expect((await listRepoSkills('ws1', 'nope')).status).toBe('error');
      expect((await listRepoSkills('ws-other', 'repo1')).status).toBe('error');
    });
  });

  describe('getRepoSkillContent', () => {
    it('returns the cached skill by name', async () => {
      mockTreePath();
      const skill = await getRepoSkillContent('ws1', 'repo1', 'reviewer');
      expect(skill?.content).toBe(SKILL_MD);
    });

    it('refreshes once when the name is not in a fresh listing', async () => {
      mockTreePath();
      await listRepoSkills('ws1', 'repo1'); // warm the cache without "new-skill"
      expect(await getRepoSkillContent('ws1', 'repo1', 'new-skill')).toBeNull();
      // The miss must have forced a refresh fetch.
      expect(mockTree).toHaveBeenCalledTimes(2);
    });
  });

  describe('skill usage', () => {
    it('bumps a counter with upsert semantics and reads it back', async () => {
      await bumpSkillUsage('ws1', 'platform:abc');
      await bumpSkillUsage('ws1', 'platform:abc');
      await bumpSkillUsage('ws1', 'local:reviewer');
      const usage = await getSkillUsage('ws1');
      expect(usage['platform:abc'].count).toBe(2);
      expect(usage['local:reviewer'].count).toBe(1);
      expect(new Date(usage['platform:abc'].lastUsedAt).getTime()).toBeGreaterThan(0);
    });

    it('scopes usage to the workspace', async () => {
      await seedUser(db, { id: 'user-2' });
      await db.insert(workspacesTable).values({ id: 'ws2', ownerId: 'user-2', name: 'other', settings: {} });
      await bumpSkillUsage('ws1', 'platform:abc');
      await bumpSkillUsage('ws2', 'platform:abc');
      expect(Object.keys(await getSkillUsage('ws1'))).toEqual(['platform:abc']);
      expect((await getSkillUsage('ws1'))['platform:abc'].count).toBe(1);
    });
  });
});
