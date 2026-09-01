import { Router } from 'express';
import type { ApiResponse, ReleaseNoteEntry } from '@talyn/shared';
import { parseVersion } from '@talyn/shared';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  ingestTokenValid,
  latestReleaseNote,
  listReleaseNotes,
  parseHighlights,
  releaseIngestConfigured,
  upsertReleaseNote,
} from '../services/releaseNotes.js';

/**
 * The "What's new" feed — read by every client, written by CI.
 *
 * Two routers rather than one because they sit on opposite sides of the auth
 * boundary. The ingest is called by a GitHub Actions job with no Supabase
 * session, so it mounts in the public block and authenticates with a shared
 * secret; the reads are for signed-in clients but the content is global, so
 * they mount before `ownerScope` (an owner-scoped transaction would pin a
 * pooled connection to filter a table with no owner column).
 */

/** The header CI presents. Matches the `X-Talyn-*` convention already in use. */
export const RELEASE_SECRET_HEADER = 'x-talyn-release-secret';

/**
 * `POST /release-notes` — record one release's highlights. Public mount,
 * shared-secret auth.
 *
 * When `TALYN_RELEASE_INGEST_SECRET` is unset the route 404s rather than
 * accepting anything: an ingest without the secret configured is not a
 * development convenience, it is an unauthenticated write into a modal every
 * user sees on launch.
 */
export function releaseNotesPublicRoutes(): Router {
  const router = Router();

  // Attached to the route, not the mount: the read routes share this path, and
  // a mount-level limiter would let ordinary launches from an office behind one
  // NAT exhaust a budget sized for one write per release. Unauthenticated until
  // the secret check below returns, so a bound belongs here — 30/min is orders
  // of magnitude above the real traffic (one POST per nightly) and still turns
  // a brute force against the secret into a non-starter.
  const ingestLimit = rateLimit({
    windowMs: 60_000,
    max: 30,
    message: 'Too many release-notes writes — slow down.',
  });

  router.post('/', ingestLimit, async (req, res) => {
    if (!releaseIngestConfigured()) {
      // Deliberately indistinguishable from "no such route" — an unconfigured
      // deployment should not advertise that this endpoint exists.
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const presented = req.header(RELEASE_SECRET_HEADER) ?? undefined;
    if (!ingestTokenValid(presented)) {
      res.status(401).json({ success: false, error: 'invalid release ingest secret' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    const version = typeof body.version === 'string' ? body.version.trim().replace(/^v/, '') : '';
    if (!parseVersion(version)) {
      res.status(400).json({ success: false, error: 'version must be X.Y.Z' });
      return;
    }

    // Provided by the caller rather than defaulted to now(): the row is the
    // release's date, and a workflow re-run months later must not restamp it.
    const publishedAt = typeof body.publishedAt === 'string' ? new Date(body.publishedAt) : null;
    if (!publishedAt || Number.isNaN(publishedAt.getTime())) {
      res.status(400).json({ success: false, error: 'publishedAt must be an ISO 8601 date' });
      return;
    }

    const highlights = parseHighlights(body.highlights);
    if (!highlights.ok) {
      res.status(400).json({ success: false, error: highlights.error });
      return;
    }

    await upsertReleaseNote({ version, publishedAt, highlights: highlights.value });
    res.status(201).json({ success: true } as ApiResponse<void>);
  });

  return router;
}

/**
 * The read side. Mounted after `requireAuth` but before `ownerScope`.
 */
export function releaseNotesRoutes(): Router {
  const router = Router();

  // GET /release-notes/latest — the newest release on record, for a client
  // establishing its first-run baseline. Declared before `/` is irrelevant
  // here (no `:param` to shadow it) but kept adjacent for readability.
  router.get('/latest', async (_req, res) => {
    const entry = await latestReleaseNote();
    res.json({ success: true, data: entry } as ApiResponse<ReleaseNoteEntry | null>);
  });

  // GET /release-notes[?since=X.Y.Z] — releases newer than `since`, newest
  // first. Without `since` this is the whole changelog, which is what the
  // Settings → About button wants.
  router.get('/', async (req, res) => {
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const entries = await listReleaseNotes(since);
    res.json({ success: true, data: entries } as ApiResponse<ReleaseNoteEntry[]>);
  });

  return router;
}
