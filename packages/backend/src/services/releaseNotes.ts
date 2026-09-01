import { desc, gt } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import {
  versionSortKey,
  type ReleaseHighlight,
  type ReleaseNoteEntry,
  type HighlightKind,
  type ReleaseSurface,
} from '@talyn/shared';
import { getPoolDbClient } from '../db/client.js';
import { releaseNotes as releaseNotesTable } from '../db/schema.js';

/**
 * The "What's new" feed.
 *
 * Rows are written exactly once per release by the publish workflow, after
 * electron-builder has created the GitHub release — so a version that failed
 * to build is never announced. Everything else reads them.
 *
 * EVERY QUERY HERE USES THE POOL CLIENT. `release_notes` is global content
 * with no owner column: it carries a read-only policy and a SELECT-only grant
 * for `authenticated`, and both routes are mounted outside `ownerScope`, so
 * there is no scoped transaction to inherit and nothing for RLS to filter.
 */

const HIGHLIGHT_KINDS: readonly HighlightKind[] = ['feature', 'fix', 'improvement'];
const SURFACES: readonly ReleaseSurface[] = ['desktop', 'web'];

/** Ingest is off entirely when the secret is unset — see {@link ingestTokenValid}. */
export function releaseIngestConfigured(): boolean {
  return Boolean(process.env.TALYN_RELEASE_INGEST_SECRET);
}

/**
 * Authenticate a release-notes ingest.
 *
 * A shared secret rather than a user JWT: the caller is a GitHub Actions job
 * with no Supabase session, and minting a service account for it would be a
 * credential with far more grant than "may append to one table".
 * Constant-time, because the endpoint is unauthenticated until this returns.
 *
 * Unset means the endpoint refuses everything (the all-or-nothing `POLAR_*`
 * posture). An open ingest lets anyone publish arbitrary text into a modal
 * every user sees on launch, which is a defacement channel, not merely bad
 * telemetry.
 */
export function ingestTokenValid(presented: string | undefined): boolean {
  const expected = process.env.TALYN_RELEASE_INGEST_SECRET ?? '';
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which leaks length — compare
  // against a padded copy so the work is constant either way.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the `highlights` array off the wire. Hand-rolled rather than zod to
 * match the rest of `routes/` — and all-or-nothing: one malformed highlight
 * rejects the whole POST rather than silently publishing a partial release.
 *
 * Returns the normalized array, or a human-readable problem.
 */
export function parseHighlights(raw: unknown): { ok: true; value: ReleaseHighlight[] } | {
  ok: false;
  error: string;
} {
  if (!Array.isArray(raw)) return { ok: false, error: 'highlights must be an array' };
  const out: ReleaseHighlight[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `highlights[${i}] must be an object` };
    }
    const h = item as Record<string, unknown>;
    if (!isNonEmptyString(h.title)) {
      return { ok: false, error: `highlights[${i}].title must be a non-empty string` };
    }
    if (!isNonEmptyString(h.description)) {
      return { ok: false, error: `highlights[${i}].description must be a non-empty string` };
    }
    if (!HIGHLIGHT_KINDS.includes(h.kind as HighlightKind)) {
      return {
        ok: false,
        error: `highlights[${i}].kind must be one of ${HIGHLIGHT_KINDS.join(', ')}`,
      };
    }
    const surfaces = h.surfaces;
    if (
      !Array.isArray(surfaces) ||
      surfaces.length === 0 ||
      !surfaces.every((s) => SURFACES.includes(s as ReleaseSurface))
    ) {
      return {
        ok: false,
        error: `highlights[${i}].surfaces must be a non-empty subset of ${SURFACES.join(', ')}`,
      };
    }
    out.push({
      title: h.title.trim(),
      description: h.description.trim(),
      kind: h.kind as HighlightKind,
      // Deduped: a highlight tagged ['web','web'] would render twice on web
      // for no reason a reader could see.
      surfaces: [...new Set(surfaces as ReleaseSurface[])],
    });
  }
  return { ok: true, value: out };
}

/**
 * Record (or re-record) one release's notes.
 *
 * Idempotent on `version`, because a re-run of the publish workflow is a
 * perfectly ordinary thing and must not double-insert or 409. A re-run
 * REPLACES the highlights: if the generator is fixed and re-run for the same
 * version, the fix is what users should get.
 */
export async function upsertReleaseNote(entry: {
  version: string;
  publishedAt: Date;
  highlights: ReleaseHighlight[];
}): Promise<void> {
  const db = getPoolDbClient();
  await db
    .insert(releaseNotesTable)
    .values({
      version: entry.version,
      sortKey: versionSortKey(entry.version),
      publishedAt: entry.publishedAt,
      highlights: entry.highlights,
    })
    .onConflictDoUpdate({
      target: releaseNotesTable.version,
      set: {
        sortKey: versionSortKey(entry.version),
        publishedAt: entry.publishedAt,
        highlights: entry.highlights,
      },
    });
}

function toEntry(row: {
  version: string;
  publishedAt: Date;
  highlights: ReleaseHighlight[];
}): ReleaseNoteEntry {
  return {
    version: row.version,
    publishedAt: row.publishedAt.toISOString(),
    highlights: row.highlights,
  };
}

/**
 * Releases newer than `sinceVersion`, newest first. Omit `sinceVersion` for the
 * whole list — that is what the Settings → About button reads, and it is the
 * changelog by definition, so it is deliberately uncapped. A year of nightlies
 * is a few hundred rows of short strings; truncating it would silently present
 * a partial history as a complete one.
 *
 * An unparseable `sinceVersion` is treated as "no floor" rather than as an
 * error: the client's stored value is the only thing that can be malformed
 * here, and answering it with the full list is both harmless and self-healing.
 */
export async function listReleaseNotes(sinceVersion?: string | null): Promise<ReleaseNoteEntry[]> {
  const db = getPoolDbClient();
  const floor = sinceVersion ? versionSortKey(sinceVersion) : -1;
  const rows = await db
    .select({
      version: releaseNotesTable.version,
      publishedAt: releaseNotesTable.publishedAt,
      highlights: releaseNotesTable.highlights,
    })
    .from(releaseNotesTable)
    .where(floor >= 0 ? gt(releaseNotesTable.sortKey, floor) : undefined)
    .orderBy(desc(releaseNotesTable.sortKey));
  return rows.map(toEntry);
}

/**
 * The newest release on record, or `null` when there is none.
 *
 * This is the first-run baseline: a client with no stored "last seen" version
 * records this and shows nothing, because a brand-new user wants the app, not
 * a changelog of everything that ever shipped.
 */
export async function latestReleaseNote(): Promise<ReleaseNoteEntry | null> {
  const db = getPoolDbClient();
  const rows = await db
    .select({
      version: releaseNotesTable.version,
      publishedAt: releaseNotesTable.publishedAt,
      highlights: releaseNotesTable.highlights,
    })
    .from(releaseNotesTable)
    .orderBy(desc(releaseNotesTable.sortKey))
    .limit(1);
  return rows.length > 0 ? toEntry(rows[0]) : null;
}
