import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { githubService, resolveRepoRelativePath } from '../services/github.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

/**
 * Contents-API coverage: directory listing + file fetch, and the symlink
 * follow that makes discovery work on repos like posthog/posthog where
 * `.claude/skills` is a symlink to `.agents/skills`.
 */
type FetchInput = string | URL | Request;

function mockFetch(routes: Record<string, unknown | ((req: RequestInit | undefined) => unknown)>) {
  return vi.fn(async (input: FetchInput, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    for (const [pattern, handler] of Object.entries(routes)) {
      if (urlStr.includes(pattern)) {
        const body = typeof handler === 'function' ? handler(init) : handler;
        const status =
          typeof body === 'object' && body !== null && 'status' in body
            ? ((body as { status?: number }).status ?? 200)
            : 200;
        const payload =
          typeof body === 'object' && body !== null && 'payload' in body
            ? (body as { payload: unknown }).payload
            : body;
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`no fetch mock for ${urlStr}`);
  });
}

describe('resolveRepoRelativePath', () => {
  it.each([
    ['.claude/skills', '../.agents/skills', '.agents/skills'],
    ['.claude/skills', './nested', '.claude/nested'],
    ['a/b/c', '../../d', 'd'],
    ['top', 'other', 'other'],
  ])('%s + %s → %s', (link, target, expected) => {
    expect(resolveRepoRelativePath(link, target)).toBe(expected);
  });

  it('rejects absolute targets and root escapes', () => {
    expect(resolveRepoRelativePath('.claude/skills', '/etc/passwd')).toBeNull();
    expect(resolveRepoRelativePath('top', '../outside')).toBeNull();
    expect(resolveRepoRelativePath('a', '..')).toBeNull();
  });
});

describe('githubService contents API', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    // A stored user token so resolveAuth succeeds without the GitHub App.
    await githubService.storeToken('ws1', 'gho_test_token', 'Bearer', 'repo');
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    await cleanup();
  });

  it('follows a directory symlink to its target listing', async () => {
    const realListing = [
      { name: 'react-doctor', path: '.agents/skills/react-doctor', type: 'dir', size: 0 },
    ];
    global.fetch = mockFetch({
      '/repos/acme/widgets/contents/.claude/skills': {
        type: 'symlink',
        path: '.claude/skills',
        target: '../.agents/skills',
        size: 17,
      },
      '/repos/acme/widgets/contents/.agents/skills': realListing,
    }) as typeof fetch;

    const listing = await githubService.getDirectoryListing('ws1', 'acme', 'widgets', '.claude/skills');
    expect(listing).toEqual(realListing);
  });

  it('returns null for a symlink loop instead of recursing forever', async () => {
    global.fetch = mockFetch({
      '/repos/acme/widgets/contents/loop': {
        type: 'symlink',
        path: 'loop',
        target: './loop',
        size: 4,
      },
    }) as typeof fetch;

    const listing = await githubService.getDirectoryListing('ws1', 'acme', 'widgets', 'loop');
    expect(listing).toBeNull();
  });

  it('returns null on 404 (missing directory)', async () => {
    global.fetch = mockFetch({
      '/repos/acme/widgets/contents/.claude/skills': { status: 404, payload: { message: 'Not Found' } },
    }) as typeof fetch;

    expect(await githubService.getDirectoryListing('ws1', 'acme', 'widgets', '.claude/skills')).toBeNull();
  });

  it('follows a file symlink and decodes the real file', async () => {
    const content = Buffer.from('# skill body', 'utf8').toString('base64');
    global.fetch = mockFetch({
      '/repos/acme/widgets/contents/.claude/skills/x/SKILL.md': {
        type: 'symlink',
        path: '.claude/skills/x/SKILL.md',
        target: '../../../.agents/skills/x/SKILL.md',
        size: 30,
      },
      '/repos/acme/widgets/contents/.agents/skills/x/SKILL.md': {
        type: 'file',
        path: '.agents/skills/x/SKILL.md',
        size: 12,
        encoding: 'base64',
        content,
      },
    }) as typeof fetch;

    const file = await githubService.getFileContent(
      'ws1', 'acme', 'widgets', '.claude/skills/x/SKILL.md', undefined, 1024
    );
    expect(file).toEqual({ content: '# skill body', size: 12 });
  });

  it('reports the resolved path alongside a symlinked listing', async () => {
    global.fetch = mockFetch({
      '/repos/acme/widgets/contents/.claude/skills': {
        type: 'symlink',
        path: '.claude/skills',
        target: '../.agents/skills',
        size: 17,
      },
      '/repos/acme/widgets/contents/.agents/skills': [],
    }) as typeof fetch;

    const resolved = await githubService.getDirectoryListingResolved(
      'ws1', 'acme', 'widgets', '.claude/skills'
    );
    // The git APIs address tree objects, so a caller switching to them needs
    // the target path — `git/trees/HEAD:.claude/skills` 422s on the symlink.
    expect(resolved?.path).toBe('.agents/skills');
  });

  it('returns size-only for a file over maxBytes', async () => {
    global.fetch = mockFetch({
      '/repos/acme/widgets/contents/big.md': {
        type: 'file',
        path: 'big.md',
        size: 2048,
        encoding: 'base64',
        content: 'eHh4',
      },
    }) as typeof fetch;

    const file = await githubService.getFileContent('ws1', 'acme', 'widgets', 'big.md', undefined, 1024);
    expect(file).toEqual({ content: null, size: 2048 });
  });
});

describe('githubService git trees API', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await githubService.storeToken('ws1', 'gho_test_token', 'Bearer', 'repo');
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    await cleanup();
  });

  it('reads a subdirectory tree in one request, keeping the treeish colon', async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (input: FetchInput) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [
            { path: 'react-doctor/SKILL.md', type: 'blob', mode: '100644', sha: 'abc', size: 12 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const tree = await githubService.getTreeRecursive('ws1', 'acme', 'widgets', 'HEAD:.agents/skills');
    expect(tree).toEqual({
      truncated: false,
      entries: [{ path: 'react-doctor/SKILL.md', type: 'blob', mode: '100644', sha: 'abc', size: 12 }],
    });
    expect(seen).toHaveLength(1);
    // GitHub must still see the `HEAD:` separator; only the path is encoded.
    expect(seen[0]).toContain('/git/trees/HEAD:.agents/skills?recursive=1');
  });

  it('percent-encodes path segments but not the separators', async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (input: FetchInput) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ tree: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await githubService.getTreeRecursive('ws1', 'acme', 'widgets', 'HEAD:docs/my skills');
    expect(seen[0]).toContain('/git/trees/HEAD:docs/my%20skills?recursive=1');
  });

  it('surfaces a truncated tree rather than a partial directory', async () => {
    global.fetch = mockFetch({
      '/git/trees/': { truncated: true, tree: [{ path: 'a/SKILL.md', type: 'blob', mode: '100644', sha: 'a' }] },
    }) as typeof fetch;

    const tree = await githubService.getTreeRecursive('ws1', 'acme', 'widgets', 'HEAD:x');
    expect(tree?.truncated).toBe(true);
  });

  it('returns null when the treeish is not a tree (404 / 422)', async () => {
    global.fetch = mockFetch({
      '/git/trees/': { status: 404, payload: { message: 'Not Found' } },
    }) as typeof fetch;
    expect(await githubService.getTreeRecursive('ws1', 'acme', 'widgets', 'HEAD:missing')).toBeNull();

    // A symlink path: GitHub understands it and refuses — "SHA must identify
    // a commit or a tree".
    global.fetch = mockFetch({
      '/git/trees/': { status: 422, payload: { message: 'Invalid object requested.' } },
    }) as typeof fetch;
    expect(await githubService.getTreeRecursive('ws1', 'acme', 'widgets', 'HEAD:.claude/skills')).toBeNull();
  });

  it('propagates other failures so the caller can fall back or retry', async () => {
    global.fetch = mockFetch({
      '/git/trees/': { status: 403, payload: { message: 'You have exceeded a secondary rate limit' } },
    }) as typeof fetch;
    await expect(
      githubService.getTreeRecursive('ws1', 'acme', 'widgets', 'HEAD:x')
    ).rejects.toThrow(/403/);
  });
});
