import type { ApiResponse } from '@talyn/shared';
import { internalProxyHeaders } from '../middleware/auth.js';

/**
 * The MCP tool handlers reach FastOwl's capabilities by calling the backend's
 * OWN REST API over loopback, authenticated with the internal-proxy headers
 * (the same seam the daemon WS proxy uses). This is deliberate: it reuses the
 * routes' validation + owner-scoped RLS verbatim, so a tool can never see or
 * mutate another user's data and we duplicate zero business logic.
 */
function apiBase(): string {
  const port = process.env.PORT || 4747;
  return `http://127.0.0.1:${port}/api/v1`;
}

export class McpApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'McpApiError';
  }
}

/**
 * Call a backend REST endpoint as `ownerId`. Unwraps `ApiResponse<T>` and
 * throws `McpApiError` on a non-2xx / `success: false` payload.
 */
export async function callApi<T>(
  ownerId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...internalProxyHeaders(ownerId),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await res.json()) as ApiResponse<T>;
  } catch {
    if (res.status === 204) return undefined as T;
    throw new McpApiError(`Invalid JSON from ${method} ${path}`, res.status);
  }
  if (!payload || payload.success !== true) {
    throw new McpApiError(payload?.error || `${method} ${path} failed`, res.status);
  }
  return payload.data as T;
}

// ---------- Lightweight response shapes (mirrors the backend public shapes) ----------

export interface PrChecks {
  total: number;
  passed: number;
  failed: number;
  inProgress: number;
  skipped: number;
}

export interface PrSummary {
  title: string;
  author: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  url: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  effectiveReviewDecision: string | null;
  blockingReason: string;
  checks: PrChecks;
  unresolvedReviewThreads: number;
}

export interface PublicPr {
  id: string;
  workspaceId: string;
  repositoryId: string;
  taskId: string | null;
  owner: string;
  repo: string;
  number: number;
  state: string;
  reviewRequested: boolean;
  authored: boolean;
  summary: PrSummary;
  autoKeepMergeable: boolean;
  mergeQueued: boolean;
  mergeMethod: string;
  /**
   * The merge queue's own view of this PR, straight from `merge_queue_entries`.
   * Replaced the v1 `mergeQueueState` blob, which carried only four statuses —
   * this one distinguishes awaiting_ci / awaiting_review / awaiting_external /
   * awaiting_stack / automerge_armed, which is most of what a reader wants to
   * know about a PR that is sitting in a queue and not moving.
   */
  mergeQueue: {
    status: string;
    position: number;
    reason?: string;
    blockedCode?: string | null;
  } | null;
}
