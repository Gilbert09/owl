// Shared helpers for the two background services that fire a cloud
// "take this PR to a clean, mergeable state" run: the auto-keep-mergeable
// watcher (prAutoMergeWatcher) and the merge queue (mergeQueueProcessor).
//
// Both need the same two lookups — which cloud env to dispatch to, and whether
// the PR's linked task is still working — so they live here to avoid drift.

import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  buildMergeablePrompt,
  type CloudProviderType,
  type PRMergeableSummary,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  workspaces as workspacesTable,
  environments as environmentsTable,
} from '../db/schema.js';
import { readFailingChecks } from './failingChecks.js';
import { getCloudProvider } from './cloudProviders/registry.js';
import { fleetRefusalReason, workspaceMayUseFleet } from './cloudProviders/fleetAccess.js';
import { createCloudTask } from './taskCreate.js';
import {
  workspacePromptTemplate,
  workspaceRespondToHumanComments,
} from './promptTemplates.js';

/** Task statuses that mean a run is still working the PR. */
export const ACTIVE_STATUSES = new Set(['pending', 'queued', 'in_progress']);

/** The workspace owner's PostHog Code env marker, or null if none. */
export async function resolvePostHogEnvId(workspaceId: string): Promise<string | null> {
  return envIdForType(workspaceId, 'posthog_code');
}

/** The auto-provisioned env marker of a given provider type for a workspace
 *  (env markers are per-owner; credentials are per-workspace). */
async function envIdForType(
  workspaceId: string,
  type: CloudProviderType
): Promise<string | null> {
  const rows = await getDbClient()
    .select({ envId: environmentsTable.id })
    .from(workspacesTable)
    .innerJoin(
      environmentsTable,
      and(
        eq(environmentsTable.ownerId, workspacesTable.ownerId),
        eq(environmentsTable.type, type)
      )
    )
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.envId ?? null;
}

/**
 * Deterministic fallback order when no specific default is pinned (or it isn't
 * connected): TALYN FLEET FIRST, then PostHog Code.
 *
 * The fleet leads because it is the better place for the work — a real microVM,
 * the workspace's own agent subscription rather than metered credits, and a
 * credential proxy that keeps every token out of the guest. PostHog Code stays
 * second rather than being removed: it is what a workspace that is not on the
 * fleet allow-list runs on, and it is what a fleet at capacity falls back to.
 *
 * The `selfhosted` link is DROPPED from the chain for a workspace that may not
 * use the fleet (see `workspaceMayUseFleet`), so a non-allow-listed workspace
 * gets exactly today's behaviour: the chain heads at PostHog Code.
 */
const CLOUD_PROVIDER_ORDER: CloudProviderType[] = ['selfhosted', 'posthog_code'];

async function defaultCloudProvider(
  workspaceId: string
): Promise<CloudProviderType | 'ask' | null> {
  const rows = await getDbClient()
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const settings = (rows[0]?.settings as { defaultCloudProvider?: CloudProviderType | 'ask' } | null) ?? {};
  return settings.defaultCloudProvider ?? null;
}

/** A resolved cloud target: which env marker to dispatch to, and the provider
 *  type behind it (so the caller can build a provider-appropriate prompt). */
export interface ResolvedCloudEnv {
  envId: string;
  provider: CloudProviderType;
}

/**
 * The cloud env a backend-initiated fix task (auto-keep-mergeable watcher,
 * merge-queue auto-fix) should dispatch to, plus the provider behind it. Honours
 * the workspace's `defaultCloudProvider` setting — a specific provider wins when
 * it's connected, otherwise (or for `'ask'`/unset) we fall back through {@link
 * CLOUD_PROVIDER_ORDER} since background tasks can't prompt. A provider counts as
 * usable only when it has stored credentials AND an env marker. Null when none
 * qualify.
 */
export async function resolveCloudEnv(workspaceId: string): Promise<ResolvedCloudEnv | null> {
  return (await resolveCloudEnvChain(workspaceId))[0] ?? null;
}

/**
 * Every provider this workspace could dispatch to, in preference order.
 *
 * The fail-back list of §10.7. `resolveCloudEnv` is the head of it and stays
 * the answer for callers that just want somewhere to send a task; the task
 * queue walks the whole chain, so a **capacity** refusal from the first choice
 * moves to the second rather than failing the user's work (§11.6). That is the
 * property that lets the self-hosted fleet be smaller than peak demand — a full
 * box degrades to a hosted provider instead of to an error.
 *
 * `selfhosted` now HEADS the standard order rather than being reachable only by
 * being pinned. It is still dropped from the chain entirely when the workspace
 * is not on the fleet allow-list, and falling through is deliberate: a
 * workspace that cannot use the fleet should get its task run somewhere, not
 * fail.
 */
export async function resolveCloudEnvChain(workspaceId: string): Promise<ResolvedCloudEnv[]> {
  const pinned = await defaultCloudProvider(workspaceId);
  const order: CloudProviderType[] =
    pinned && pinned !== 'ask'
      ? [pinned, ...CLOUD_PROVIDER_ORDER.filter((t) => t !== pinned)]
      : CLOUD_PROVIDER_ORDER;

  const chain: ResolvedCloudEnv[] = [];
  for (const type of order) {
    const provider = getCloudProvider(type);
    if (!provider) continue;
    if (type === 'selfhosted' && !(await workspaceMayUseFleet(workspaceId))) {
      console.warn(
        `[cloudEnv] workspace ${workspaceId.slice(0, 8)} prefers the fleet but ${fleetRefusalReason()}; skipping it`,
      );
      continue;
    }
    if (!(await provider.hasCredentials(workspaceId))) continue;
    const envId = await envIdForType(workspaceId, type);
    if (envId) chain.push({ envId, provider: type });
  }
  return chain;
}

/** Env-id-only convenience over {@link resolveCloudEnv}. */
export async function resolveCloudEnvId(workspaceId: string): Promise<string | null> {
  return (await resolveCloudEnv(workspaceId))?.envId ?? null;
}

/** Current status of the PR's most-recently-linked task, or null. */
/**
 * The id of a task already working this pull request, or null.
 *
 * THIS is the in-flight guard every dispatch path should use. The obvious
 * alternative — read `pull_requests.task_id` and check its status — cannot
 * answer the question: a PR accumulates many tasks, that column holds only the
 * most recently attached one, and any source overwriting it (a manual run, the
 * merge queue, a task that opened the PR) leaves an earlier run invisible. The
 * auto-keep watcher did exactly that on 2026-09-01 and put three concurrent
 * runs on PostHog/posthog#92090, which then filled the free plan's task cap.
 *
 * Scoped to the workspace as well as the PR: `pull_requests` rows are
 * per-workspace, so this is belt-and-braces, but it keeps the guard honest if
 * a row is ever shared.
 */
export async function activePrTaskId(
  workspaceId: string,
  pullRequestId: string,
  /** Ignore this task — the caller's own dispatch, which it tracks separately. */
  excludeTaskId?: string | null
): Promise<string | null> {
  const rows = await getDbClient()
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.pullRequestId, pullRequestId),
        eq(tasksTable.workspaceId, workspaceId),
        inArray(tasksTable.status, [...ACTIVE_STATUSES]),
        ...(excludeTaskId ? [ne(tasksTable.id, excludeTaskId)] : [])
      )
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function linkedTaskStatus(taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  const db = getDbClient();
  const rows = await db
    .select({ status: tasksTable.status })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return rows[0]?.status ?? null;
}

/**
 * The linked run's status AND when it started — the merge queue needs both.
 * Separate from {@link linkedTaskStatus} so its callers keep their shape; this
 * is one query either way.
 */
export async function linkedTaskRun(
  taskId: string | null
): Promise<{ status: string; startedAt: Date } | null> {
  if (!taskId) return null;
  const rows = await getDbClient()
    .select({ status: tasksTable.status, createdAt: tasksTable.createdAt })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const row = rows[0];
  return row ? { status: row.status, startedAt: row.createdAt } : null;
}

/** Minimal PR shape needed to fire a "get mergeable" run. */
export interface PrFixRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  number: number;
  lastSummary: unknown;
}

export type PrFixResult =
  | { ok: true; task: Awaited<ReturnType<typeof createCloudTask>> }
  | { ok: false; reason: 'no_cloud_provider' };

/**
 * The canonical "fix this PR" action — the one the desktop fix button, the
 * merge-queue, and the auto-keep-mergeable watcher all express: resolve the
 * workspace's cloud provider, build FastOwl's STANDARD `buildMergeablePrompt`,
 * and queue a `pr_response` task linked to the PR. Callers pass only the PR
 * row; everything (provider, env, prompt) is derived. Returns `no_cloud_provider`
 * when the workspace has no connected provider to dispatch to.
 */
export async function startPrMergeableRun(
  row: PrFixRow,
  opts: {
    title?: string;
    description?: string;
    model?: string;
  } = {}
): Promise<PrFixResult> {
  const resolved = await resolveCloudEnv(row.workspaceId);
  if (!resolved) return { ok: false, reason: 'no_cloud_provider' };
  const { envId, provider } = resolved;

  const summary = (row.lastSummary ?? {}) as PRMergeableSummary;
  const ref = `${row.owner}/${row.repo}#${row.number}`;
  const failingChecks = await readFailingChecks(
    row.workspaceId,
    row.owner,
    row.repo,
    row.number,
    summary
  );
  const prTitle = summary.title ?? '';
  const template = await workspacePromptTemplate(row.workspaceId, 'mergeable');
  const respondToHumanComments = await workspaceRespondToHumanComments(row.workspaceId);

  const task = await createCloudTask({
    workspaceId: row.workspaceId,
    type: 'pr_response',
    title: opts.title ?? `Get ${ref} mergeable`,
    description:
      opts.description ?? `Take ${ref} ("${prTitle}") to a clean, mergeable state.`,
    prompt: buildMergeablePrompt({
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      summary,
      provider,
      failingChecks,
      template,
      respondToHumanComments,
    }),
    repositoryId: row.repositoryId,
    assignedEnvironmentId: envId,
    pullRequestId: row.id,
    model: opts.model,
  });
  return { ok: true, task };
}
