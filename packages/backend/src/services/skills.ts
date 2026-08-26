// Skills service — repo-skill discovery (GitHub contents + git trees APIs and
// a cache), platform-skill CRUD helpers, and the per-workspace usage counters
// that order the desktop's skill picker.
//
// Repo skills live at `.claude/skills/<dir>/SKILL.md` on the repo's default
// branch. Discovery passes NO ref to the contents API on purpose — GitHub
// then resolves the repo's actual default branch. The repositories row's
// `defaultBranch` column is untrustworthy here: addWatchedRepo hardcodes
// 'main' and nothing corrects it, so a master-defaulted repo (e.g.
// posthog/posthog) would 404 on ?ref=main and report "no skills".
// Fork PRs need no special handling: a task's repositoryId always points at
// the watched base repo.
//
// Cost: discovery used to list every skill directory one request at a time —
// 89 listings plus 88 file reads on posthog/posthog, fired with no bound, per
// discovery. That burst is what GitHub's *secondary* limit counts (it caps
// concurrent requests per account, shared with the poll loops), and once that
// gate is closed `waitIfBlocked` throws, so the picker reported "Couldn't load
// this repo's skills" for the whole backoff. Now: one recursive tree call
// finds every SKILL.md, blob shas skip content that hasn't changed, and the
// reads that remain run at a bounded concurrency.

import { eq, sql } from 'drizzle-orm';
import {
  parseSkillFrontmatter,
  repoSkillKey,
  SKILL_MAX_BYTES,
  type SkillSummary,
  type SkillUsageEntry,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { repositories as repositoriesTable, skillUsage as skillUsageTable } from '../db/schema.js';
import { githubService, type GitHubContentsEntry } from './github.js';
import { parseRepoUrl } from './repoIdentity.js';

const SKILLS_DIR = '.claude/skills';
const SKILL_FILE = 'SKILL.md';
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * How many SKILL.md reads are in flight at once.
 *
 * GitHub's secondary limit trips at 100 concurrent requests *per account* — a
 * ceiling this discovery shares with the poll loops (3 GraphQL queries), the
 * merge queue, and every other workspace on the same installation. 10 keeps
 * discovery's share around a tenth of it, and reads a cold 88-skill repo
 * (posthog/posthog) in ~6s against ~12s at 6. It only bounds the COLD path:
 * a re-discovery reads the skills whose blob sha moved and nothing else.
 */
export const CONTENT_CONCURRENCY = 10;

export type RepoSkillStatus = 'ok' | 'none' | 'error';

export interface RepoSkill extends SkillSummary {
  source: 'repo';
  repositoryId: string;
  repoPath: string;
  /** Full SKILL.md text; null when the file exceeds SKILL_MAX_BYTES. */
  content: string | null;
}

export interface RepoSkillsResult {
  status: RepoSkillStatus;
  skills: RepoSkill[];
  /** GitHub's message, on `status: 'error'` — surfaced to the picker. */
  error?: string;
}

interface CacheEntry {
  fetchedAt: number;
  result: RepoSkillsResult;
}

/** A SKILL.md located by discovery, before its content is resolved. */
interface SkillFile {
  /** Directory name — the fallback skill name when frontmatter has none. */
  dirName: string;
  /** Full repo path of the SKILL.md. */
  path: string;
  /** Blob sha, when discovery came from the tree API. Keys the content cache. */
  sha?: string;
  /** Blob size in bytes, when known — lets an oversized skill skip its read. */
  size?: number;
  hasSupportingFiles: boolean;
}

interface BlobContent {
  content: string | null;
  size: number;
}

// Keyed by repositoryId. In-memory on purpose: skill listings are small,
// refetching after a restart is one cheap contents call, and an explicit
// `refresh` bypass covers "I just pushed a skill".
const repoSkillCache = new Map<string, CacheEntry>();

// Keyed by repositoryId → blob sha → content. Outlives the listing TTL: a
// SKILL.md's sha only moves when the file changes, so a re-discovery re-reads
// the skills that changed and nothing else. Rebuilt from the shas each
// discovery actually saw, so a deleted skill's blob doesn't linger.
const blobContentCache = new Map<string, Map<string, BlobContent>>();

/** Test hook. */
export function clearRepoSkillCache(): void {
  repoSkillCache.clear();
  blobContentCache.clear();
}

// One pool for the whole process, not one per discovery: the desktop
// prefetches skills for EVERY watched repo the moment a workspace loads, so a
// per-call bound would still multiply by the repo count — the same burst,
// reassembled.
let inFlight = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < CONTENT_CONCURRENCY) {
    inFlight++;
    return;
  }
  // No increment on wake: releaseSlot HANDS the slot over rather than freeing
  // it. Decrementing there and re-incrementing here would leave the counter
  // low for a microtask — long enough for a fresh caller to claim the same
  // slot and put two readers over the bound.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) {
    next();
    return;
  }
  inFlight--;
}

/**
 * Run `fn` over `items` against the shared slot pool. Order preserved. Never
 * call this from inside another `mapBounded` callback — a nested acquire on a
 * full pool waits for a slot its own holder will never release.
 */
async function mapBounded<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  return Promise.all(
    items.map(async (item) => {
      await acquireSlot();
      try {
        return await fn(item);
      } finally {
        releaseSlot();
      }
    })
  );
}

async function loadRepoIdentity(
  repositoryId: string,
  workspaceId: string
): Promise<{ owner: string; repo: string } | null> {
  const db = getDbClient();
  const rows = await db
    .select({
      id: repositoriesTable.id,
      workspaceId: repositoriesTable.workspaceId,
      url: repositoriesTable.url,
    })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, repositoryId))
    .limit(1);
  const row = rows[0];
  if (!row || row.workspaceId !== workspaceId) return null;
  const identity = parseRepoUrl(row.url);
  if (!identity) return null;
  return { owner: identity.owner, repo: identity.repo };
}

/**
 * Locate every `<dir>/SKILL.md` under the skills dir in ONE request, from a
 * recursive git tree. Returns null when the tree is unavailable or truncated
 * — a partial tree must not be read as the whole directory — so the caller
 * falls back to walking the directories.
 */
async function skillFilesFromTree(
  workspaceId: string,
  repo: { owner: string; repo: string },
  rootPath: string
): Promise<SkillFile[] | null> {
  const tree = await githubService.getTreeRecursive(
    workspaceId,
    repo.owner,
    repo.repo,
    `HEAD:${rootPath}`
  );
  if (!tree || tree.truncated) return null;

  // Paths are relative to the skills dir: `<skill>/SKILL.md`, plus whatever
  // else the skill ships. An entry with no `/` is the skill dir itself (or a
  // stray file next to the skills), and belongs to no skill.
  const found = new Map<string, SkillFile>();
  const supporting = new Set<string>();
  for (const entry of tree.entries) {
    const slash = entry.path.indexOf('/');
    if (slash === -1) continue;
    const dirName = entry.path.slice(0, slash);
    const rest = entry.path.slice(slash + 1);
    if (rest === SKILL_FILE && entry.type === 'blob') {
      // A symlinked SKILL.md reports as a blob whose content is the link
      // text, and its sha tracks the LINK, not the file it points at. Leaving
      // the sha off makes it re-read every discovery — the alternative is
      // serving a target's stale content forever.
      const isSymlink = entry.mode === '120000';
      found.set(dirName, {
        dirName,
        path: `${rootPath}/${entry.path}`,
        sha: isSymlink ? undefined : entry.sha,
        size: isSymlink ? undefined : entry.size,
        hasSupportingFiles: false,
      });
    } else {
      supporting.add(dirName);
    }
  }
  return [...found.values()].map((f) => ({
    ...f,
    hasSupportingFiles: supporting.has(f.dirName),
  }));
}

/**
 * Locate SKILL.md files by listing each directory — one request per entry.
 * The fallback for a truncated/unavailable tree, and the only way to read a
 * *symlinked* skill dir, whose target the tree doesn't carry.
 */
async function skillFilesFromWalk(
  workspaceId: string,
  repo: { owner: string; repo: string },
  entries: GitHubContentsEntry[]
): Promise<SkillFile[]> {
  const walked = await mapBounded(entries, async (dir): Promise<SkillFile | null> => {
    const listing = await githubService.getDirectoryListing(
      workspaceId,
      repo.owner,
      repo.repo,
      dir.path,
      undefined
    );
    const skillFile = listing?.find((e) => e.type === 'file' && e.name === SKILL_FILE);
    if (!listing || !skillFile) return null;
    return {
      dirName: dir.name,
      path: skillFile.path,
      size: skillFile.size,
      hasSupportingFiles: listing.some((e) => e.name !== SKILL_FILE),
    };
  });
  return walked.filter((f): f is SkillFile => f !== null);
}

async function fetchRepoSkills(
  workspaceId: string,
  repositoryId: string
): Promise<RepoSkillsResult> {
  const repo = await loadRepoIdentity(repositoryId, workspaceId);
  if (!repo) return { status: 'error', skills: [], error: 'Repository not found in this workspace' };

  // ref deliberately omitted throughout — GitHub resolves the repo's real
  // default branch (see the header comment). The resolved path matters: on
  // posthog/posthog `.claude/skills` is a symlink to `.agents/skills`, and
  // the tree API addresses tree objects, not links.
  const root = await githubService.getDirectoryListingResolved(
    workspaceId,
    repo.owner,
    repo.repo,
    SKILLS_DIR,
    undefined
  );
  if (root === null) return { status: 'none', skills: [] };

  const dirs = root.entries.filter((e) => e.type === 'dir');
  // Symlinked entries can be skill dirs too — they resolve outside this tree,
  // so they're always walked (if one turns out to be a file, its listing is
  // null and it's skipped).
  const symlinks = root.entries.filter((e) => e.type === 'symlink');

  const fromTree = dirs.length > 0 ? await skillFilesFromTree(workspaceId, repo, root.path) : [];
  const files = [
    ...(fromTree ?? (await skillFilesFromWalk(workspaceId, repo, dirs))),
    ...(symlinks.length > 0 ? await skillFilesFromWalk(workspaceId, repo, symlinks) : []),
  ];

  const cachedBlobs = blobContentCache.get(repositoryId);
  const seenBlobs = new Map<string, BlobContent>();

  const skills = await mapBounded(files, async (file): Promise<RepoSkill | null> => {
    let blob: BlobContent | null = null;
    if (file.size !== undefined && file.size > SKILL_MAX_BYTES) {
      // Known to be unrunnable — list it, but don't spend a request on it.
      blob = { content: null, size: file.size };
    } else if (file.sha && cachedBlobs?.has(file.sha)) {
      blob = cachedBlobs.get(file.sha)!;
    } else {
      blob = await githubService.getFileContent(
        workspaceId,
        repo.owner,
        repo.repo,
        file.path,
        undefined,
        SKILL_MAX_BYTES
      );
    }
    if (!blob) return null;
    if (file.sha) seenBlobs.set(file.sha, blob);

    const parsed = blob.content !== null ? parseSkillFrontmatter(blob.content) : null;
    const name = parsed?.name ?? file.dirName;
    return {
      key: repoSkillKey(repo.owner, repo.repo, name),
      source: 'repo',
      name,
      description: parsed?.description ?? '',
      repositoryId,
      repoPath: file.path,
      hasSupportingFiles: file.hasSupportingFiles,
      contentSize: blob.size,
      content: blob.content,
    };
  });

  blobContentCache.set(repositoryId, seenBlobs);
  return { status: 'ok', skills: skills.filter((s): s is RepoSkill => s !== null) };
}

/**
 * Skills discovered in a watched repo, cached for CACHE_TTL_MS. On a GitHub
 * failure a stale cache entry is served rather than dropped — a rate-limited
 * tick shouldn't blank the picker. An `error` result is never cached: it says
 * nothing about the repo, so holding it would keep the picker broken for the
 * rest of the TTL.
 */
export async function listRepoSkills(
  workspaceId: string,
  repositoryId: string,
  opts: { refresh?: boolean } = {}
): Promise<RepoSkillsResult> {
  const cached = repoSkillCache.get(repositoryId);
  if (!opts.refresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }
  try {
    const result = await fetchRepoSkills(workspaceId, repositoryId);
    if (result.status === 'error') return cached?.result ?? result;
    repoSkillCache.set(repositoryId, { fetchedAt: Date.now(), result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] repo skill discovery failed for ${repositoryId}: ${message}`);
    if (cached) return cached.result;
    return { status: 'error', skills: [], error: message };
  }
}

/** A single repo skill's content, cache-first with fetch-through. */
export async function getRepoSkillContent(
  workspaceId: string,
  repositoryId: string,
  name: string
): Promise<RepoSkill | null> {
  const listed = await listRepoSkills(workspaceId, repositoryId);
  const hit = listed.skills.find((s) => s.name === name);
  if (hit) return hit;
  if (listed.status === 'ok' || listed.status === 'none') {
    // Fresh listing didn't have it — maybe pushed since the cache filled.
    const refreshed = await listRepoSkills(workspaceId, repositoryId, { refresh: true });
    return refreshed.skills.find((s) => s.name === name) ?? null;
  }
  return null;
}

/** Usage stats for every skill key the workspace has run, for picker ordering. */
export async function getSkillUsage(
  workspaceId: string
): Promise<Record<string, SkillUsageEntry>> {
  const db = getDbClient();
  const rows = await db
    .select({
      skillKey: skillUsageTable.skillKey,
      usageCount: skillUsageTable.usageCount,
      lastUsedAt: skillUsageTable.lastUsedAt,
    })
    .from(skillUsageTable)
    .where(eq(skillUsageTable.workspaceId, workspaceId));
  const out: Record<string, SkillUsageEntry> = {};
  for (const row of rows) {
    out[row.skillKey] = { count: row.usageCount, lastUsedAt: row.lastUsedAt.toISOString() };
  }
  return out;
}

/** Bump a skill's usage counter (fire-and-forget from task creation). */
export async function bumpSkillUsage(workspaceId: string, skillKey: string): Promise<void> {
  const db = getDbClient();
  const now = new Date();
  await db
    .insert(skillUsageTable)
    .values({ workspaceId, skillKey, usageCount: 1, lastUsedAt: now })
    .onConflictDoUpdate({
      target: [skillUsageTable.workspaceId, skillUsageTable.skillKey],
      set: {
        usageCount: sql`${skillUsageTable.usageCount} + 1`,
        lastUsedAt: now,
      },
    });
}
