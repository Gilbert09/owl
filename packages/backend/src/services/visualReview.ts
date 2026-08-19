// PostHog Visual Review — the screenshot-regression gate, and how the merge
// queue gets past it.
//
// VR is a HUMAN-DECISION gate. CI renders storybook/playwright snapshots,
// diffs them against committed baselines, and holds the PR's `visual-review`
// check red until a person approves each changed snapshot in the VR UI. No
// code an agent can write greens it.
//
// That is why it deadlocked the queue: a fix run pushes a commit, the commit
// triggers a fresh VR run, the fresh run carries the SAME unapproved diffs, and
// the PR is red again. PostHog/posthog#83850 went round 11 times in two days
// with an identical set of 4 changed snapshots (2026-08-19).
//
// Two exits, chosen per workspace by `settings.visualReview.autoApprove`:
//
//   off (default) — the queue recognises the gate, spends NO cloud run on it,
//                   and parks the PR naming the run for a human.
//   on            — the queue finalizes the run itself: approve every pending
//                   diff, commit the new baseline, green the gate.
//
// `finalize` is the irreversible one. It rewrites the baseline committed to the
// PR branch, so an unintended regression is shipped exactly as readily as an
// intended one — nothing in here can tell them apart. That is the whole reason
// it is opt-in and defaults off.

import { getPostHogCodeCredentials } from './posthogCode/credentials.js';
import { fetchWithTimeout } from './httpTimeout.js';
import { debugBus } from './debugBus.js';

const REQUEST_TIMEOUT_MS = 30_000;

/** A non-2xx from the VR API, carrying `status` + the API's own `code`. */
export class VisualReviewApiError extends Error {
  constructor(
    readonly status: number,
    /** The API's machine code where it sets one: not_fully_resolved,
     *  stale_run, sha_mismatch, rate_limited. Null otherwise. */
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'VisualReviewApiError';
  }
}

/** One run, trimmed to what the queue actually decides on. */
export interface VisualReviewRun {
  id: string;
  prNumber: number | null;
  commitSha: string;
  status: string;
  approved: boolean;
  isStale: boolean;
  /** Diffs awaiting a decision. `changed` is the review work; `newCount` has
   *  no baseline yet and is usually trivial. */
  changed: number;
  newCount: number;
  url: string;
}

interface RawRun {
  id?: string;
  pr_number?: number | null;
  commit_sha?: string;
  status?: string;
  approved?: boolean;
  is_stale?: boolean;
  summary?: { changed?: number; new?: number };
  _posthogUrl?: string;
}

function toRun(raw: RawRun, host: string, projectId: string): VisualReviewRun | null {
  if (!raw.id) return null;
  return {
    id: raw.id,
    prNumber: raw.pr_number ?? null,
    commitSha: raw.commit_sha ?? '',
    status: raw.status ?? '',
    approved: raw.approved === true,
    isStale: raw.is_stale === true,
    changed: raw.summary?.changed ?? 0,
    newCount: raw.summary?.new ?? 0,
    url: raw._posthogUrl ?? `${host}/project/${projectId}/visual_review/runs/${raw.id}`,
  };
}

interface Credentials {
  host: string;
  projectId: string;
  getToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
}

/**
 * VR credentials for a workspace.
 *
 * Deliberately reuses the PostHog Code integration rather than adding a second
 * key to configure: it is the same PostHog account and, in every setup seen so
 * far, the same project. What it does NOT share is scope — VR needs
 * `visual_review:read` / `visual_review:write`, which a key minted for Code
 * runs will not have. That surfaces as a 403 with a message naming the missing
 * scope, which is a far better failure than a silent no-op.
 */
async function credentialsFor(
  workspaceId: string,
  projectIdOverride?: string
): Promise<Credentials | null> {
  const creds = await getPostHogCodeCredentials(workspaceId);
  if (!creds || creds.reauthRequired) return null;
  const projectId = projectIdOverride || creds.projectId;
  if (!projectId) return null;
  return { host: creds.host, projectId, getToken: creds.getToken };
}

async function request<T>(
  creds: Credentials,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${creds.host}/api/projects/${creds.projectId}/visual_review${path}`;
  const startedAt = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${await creds.getToken()}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { label: 'PostHog Visual Review', timeoutMs: REQUEST_TIMEOUT_MS }
    );
  } catch (err) {
    debugBus.recordHttp({
      service: 'visual_review',
      method,
      url,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const text = res.bodyText;
  debugBus.recordHttp({
    service: 'visual_review',
    method,
    url,
    status: res.status,
    durationMs: Date.now() - startedAt,
    ok: res.ok,
    bytes: text.length,
    ...(res.ok ? {} : { error: text.slice(0, 500) }),
  });
  if (!res.ok) {
    let code: string | null = null;
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { code?: string; detail?: string };
      code = parsed.code ?? null;
      if (parsed.detail) detail = parsed.detail;
    } catch {
      // Non-JSON body (a proxy error page) — the raw slice is the message.
    }
    throw new VisualReviewApiError(res.status, code, `${res.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * The run that is gating this PR right now, or null when nothing is.
 *
 * "Gating" is narrow on purpose:
 *   - not stale — a superseded run's verdict is about a commit that is no
 *     longer the head, and finalizing it 409s `stale_run`.
 *   - completed — a `pending` run is still uploading; it has no verdict yet.
 *   - unapproved with diffs — an approved run, or one with nothing changed,
 *     is not what is holding the check red.
 *
 * `headSha` is checked when the run reports one: finalizing against a commit
 * that is no longer the PR head is exactly the `sha_mismatch` 409, and it would
 * approve diffs the head may no longer contain.
 */
export async function gatingRunForPr(
  workspaceId: string,
  prNumber: number,
  headSha: string,
  projectIdOverride?: string
): Promise<VisualReviewRun | null> {
  const creds = await credentialsFor(workspaceId, projectIdOverride);
  if (!creds) return null;
  const body = await request<{ results?: RawRun[] }>(
    creds,
    'GET',
    `/runs/?pr_number=${encodeURIComponent(String(prNumber))}&limit=20`
  );
  const runs = (body.results ?? [])
    .map((r) => toRun(r, creds.host, creds.projectId))
    .filter((r): r is VisualReviewRun => r !== null);
  return (
    runs.find(
      (r) =>
        !r.isStale &&
        r.status === 'completed' &&
        !r.approved &&
        r.changed + r.newCount > 0 &&
        (!headSha || !r.commitSha || r.commitSha === headSha)
    ) ?? null
  );
}

export type FinalizeOutcome =
  /** Baseline committed (or nothing needed committing) and the gate greened. */
  | { kind: 'finalized'; baselineCommitSha: string | null }
  /** A newer run superseded this one — re-resolve and try that one. */
  | { kind: 'stale' }
  /** The PR moved on; CI must re-run before a finalize can land. */
  | { kind: 'sha_mismatch' }
  /** Transient (rate limit, GitHub 5xx, network) — retry later, burn nothing. */
  | { kind: 'retry'; message: string }
  /** Terminal for this head: bad scope, no GitHub App, unresolvable snapshots. */
  | { kind: 'error'; message: string };

/**
 * Approve every pending diff on a run and commit the baseline, greening the
 * gate. THE irreversible action in this module.
 *
 * Outcomes are modelled rather than thrown so the queue can tell "try again in
 * a minute" from "this will never work", and spend its budget accordingly. A
 * 409 is never an error here: `stale_run` and `sha_mismatch` both mean the PR
 * moved under us, which is ordinary on an active branch.
 */
export async function finalizeRun(
  workspaceId: string,
  runId: string,
  projectIdOverride?: string
): Promise<FinalizeOutcome> {
  const creds = await credentialsFor(workspaceId, projectIdOverride);
  if (!creds) return { kind: 'error', message: 'No PostHog credentials for this workspace.' };
  try {
    const body = await request<{ metadata?: { baseline_commit_sha?: string } }>(
      creds,
      'POST',
      `/runs/${encodeURIComponent(runId)}/finalize/`,
      { approve_all: true, commit_to_github: true, add_images_to_comment_on_pr: false }
    );
    return { kind: 'finalized', baselineCommitSha: body.metadata?.baseline_commit_sha ?? null };
  } catch (err) {
    if (err instanceof VisualReviewApiError) {
      if (err.code === 'stale_run') return { kind: 'stale' };
      if (err.code === 'sha_mismatch') return { kind: 'sha_mismatch' };
      if (err.status === 429 || err.status >= 500) {
        return { kind: 'retry', message: err.message };
      }
      if (err.status === 403) {
        return {
          kind: 'error',
          message:
            'PostHog refused the visual-review finalize (403). The workspace API key needs the ' +
            '`visual_review:write` scope — a key minted for PostHog Code runs does not have it.',
        };
      }
      return { kind: 'error', message: err.message };
    }
    // Network/timeout — indistinguishable from a slow PostHog, so retry.
    return { kind: 'retry', message: err instanceof Error ? err.message : String(err) };
  }
}
