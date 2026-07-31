import { eq } from 'drizzle-orm';
import type { AgentEvent, CloudTaskMetadata, TaskResult, TaskStatus } from '@talyn/shared';
import { readCloudTaskMeta } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable, repositories as repositoriesTable } from '../../db/schema.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate, emitTaskEvent } from '../websocket.js';
import { linkTaskToPullRequest } from '../prCache.js';
import { clearWatched } from '../cloudProviders/taskWatch.js';
import type { CloudTaskRow } from '../cloudProviders/types.js';
import { getSelfHostedClient } from './credentials.js';
import type { FleetEvent, FleetRun } from './client.js';

const TRANSCRIPT_MAX_EVENTS = 2000;
const PERSIST_INTERVAL_MS = 45_000;

/**
 * Decide whether to rewrite the transcript blob this tick. Skip when the DB is
 * already current, or when the debounce window hasn't elapsed — unless `force`
 * (a terminal tick) demands a final flush. Pure so the truth table is testable.
 */
export function shouldPersistTranscript(opts: {
  length: number;
  persistedCount: number;
  lastPersistAt: number;
  now: number;
  force: boolean;
}): boolean {
  if (opts.length === opts.persistedCount) return false;
  return opts.force || opts.now - opts.lastPersistAt >= PERSIST_INTERVAL_MS;
}

/** A fleet run is terminal exactly when the fleet says so — it owns the
 *  lifecycle and reports one of three end states. */
export function isFleetRunTerminal(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Map a fleet outcome onto a local task status.
 *
 * `cancelled` maps to `failed`, deliberately: the local model has no cancelled
 * state for a cloud run, and a run the fleet cancelled (deadline, wedge,
 * operator) did not do the work — reporting it completed would be a lie.
 */
export function taskStatusForFleetRun(status: string | undefined): TaskStatus {
  return status === 'completed' ? 'completed' : 'failed';
}

class SelfHostedPoller {
  /** taskId → highest fleet `seq` already emitted over WS + persisted. */
  private cursor = new Map<string, number>();
  /** taskId → transcript accumulated this process lifetime. */
  private transcripts = new Map<string, AgentEvent[]>();
  private persisted = new Map<string, number>();
  private lastPersistAt = new Map<string, number>();

  /** Entry point the generic cloud poller calls via the provider seam. */
  async reconcileTask(row: CloudTaskRow): Promise<void> {
    const cloud = readCloudTaskMeta({ metadata: row.metadata });
    if (!cloud || cloud.provider !== 'selfhosted' || !cloud.remoteTaskId) return;
    const runId = cloud.remoteTaskId;

    const client = await getSelfHostedClient(row.workspaceId);
    if (!client) return; // credentials removed mid-run; leave the task as-is.

    // Any error here (including the capacity/throttle types) propagates to the
    // generic poller, which logs it and retries next tick. A failed poll must
    // never fail the task — the run is still going on the metal.
    const { run } = await client.getRun(runId);
    const terminal = isFleetRunTerminal(run.status);

    // Cursor-based, unlike the other providers: the fleet assigns `seq`
    // host-side and serves events past a cursor, so we never refetch the whole
    // transcript. That keeps a long run's egress flat rather than quadratic.
    await this.syncTranscript(row, client, runId, terminal);

    const prUrl = run.prUrl ?? cloud.prUrl ?? null;
    await patchTaskMetadata(row.id, (existing) => {
      const prev = (existing.cloudTask as CloudTaskMetadata | undefined) ?? cloud;
      return {
        ...existing,
        cloudTask: {
          ...prev,
          status: run.status ?? prev.status,
          prUrl: prUrl ?? prev.prUrl,
          extra: { ...(prev.extra ?? {}), phase: run.phase, costUsd: run.costUsd },
        },
      };
    });
    emitTaskUpdate(row.workspaceId, row.id, {
      metadata: { cloudTask: { status: run.status, prUrl: prUrl ?? undefined } },
    });

    if (!terminal) return;

    if (prUrl && row.repositoryId) {
      await this.linkPr(row.workspaceId, row.repositoryId, row.id, prUrl);
    }
    await this.finalize(row.id, row.workspaceId, run, prUrl);
  }

  private async syncTranscript(
    row: CloudTaskRow,
    client: { getEvents: (runId: string, after: number) => Promise<{ events: FleetEvent[] }> },
    runId: string,
    force: boolean,
  ): Promise<void> {
    const after = this.cursor.get(row.id) ?? 0;
    let fetched: FleetEvent[];
    try {
      ({ events: fetched } = await client.getEvents(runId, after));
    } catch (err) {
      console.warn(
        `[selfhosted] getEvents failed for task ${row.id.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }

    const transcript = this.transcripts.get(row.id) ?? [];
    for (const ev of fetched) {
      // The fleet's seq is authoritative and monotonic; reuse it rather than
      // re-indexing, so a transcript survives a backend restart mid-run with
      // its numbering intact.
      transcript.push({ ...(ev.event as object), seq: ev.seq } as AgentEvent);
      this.cursor.set(row.id, Math.max(this.cursor.get(row.id) ?? 0, ev.seq));
      emitTaskEvent(row.workspaceId, row.id, transcript[transcript.length - 1]);
    }
    this.transcripts.set(row.id, transcript);

    const now = Date.now();
    if (
      !shouldPersistTranscript({
        length: transcript.length,
        persistedCount: this.persisted.get(row.id) ?? 0,
        lastPersistAt: this.lastPersistAt.get(row.id) ?? 0,
        now,
        force,
      })
    ) {
      return;
    }
    this.lastPersistAt.set(row.id, now);
    this.persisted.set(row.id, transcript.length);
    await this.persist(row.id, transcript);
  }

  private async persist(taskId: string, full: AgentEvent[]): Promise<void> {
    let transcript = full;
    if (transcript.length > TRANSCRIPT_MAX_EVENTS) {
      const head = transcript.slice(0, 100);
      const tail = transcript.slice(transcript.length - (TRANSCRIPT_MAX_EVENTS - 101));
      const marker: AgentEvent = {
        seq: -1,
        type: 'system',
        subtype: 'truncated',
        dropped: transcript.length - (head.length + tail.length),
      } as AgentEvent;
      transcript = [...head, marker, ...tail];
    }
    await getDbClient()
      .update(tasksTable)
      .set({ transcript: transcript as unknown as object, updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));
  }

  /** Drop the in-memory cursors for a task (stop/delete). */
  stopStreaming(taskId: string): void {
    this.cursor.delete(taskId);
    this.transcripts.delete(taskId);
    this.persisted.delete(taskId);
    this.lastPersistAt.delete(taskId);
  }

  private async linkPr(
    workspaceId: string,
    repositoryId: string,
    taskId: string,
    prUrl: string,
  ): Promise<void> {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) return;
    const repoRows = await getDbClient()
      .select({ defaultBranch: repositoriesTable.defaultBranch })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, repositoryId))
      .limit(1);
    try {
      const rowId = await linkTaskToPullRequest({
        workspaceId,
        repositoryId,
        taskId,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        url: prUrl,
        title: '',
        author: '',
        headBranch: '',
        baseBranch: repoRows[0]?.defaultBranch || 'main',
        headSha: '',
      });
      await patchTaskMetadata(taskId, (existing) => ({
        ...existing,
        pullRequest: {
          id: rowId,
          number: parsed.number,
          url: prUrl,
          createdAt: new Date().toISOString(),
        },
      }));
    } catch (err) {
      console.warn(
        `[selfhosted] failed to link PR for task ${taskId.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async finalize(
    taskId: string,
    workspaceId: string,
    run: FleetRun,
    prUrl: string | null,
  ): Promise<void> {
    this.stopStreaming(taskId);
    clearWatched(taskId);

    const status = taskStatusForFleetRun(run.status);
    const result: TaskResult =
      status === 'completed'
        ? {
            success: true,
            summary: prUrl ? `The fleet opened ${prUrl}` : 'Fleet run completed',
          }
        : {
            success: false,
            summary: run.error || `Fleet run ended ${run.status}`,
            error: run.error || `Run ended with status "${run.status}"`,
          };

    const now = new Date();
    await getDbClient()
      .update(tasksTable)
      .set({
        status,
        result,
        completedAt: status === 'completed' ? now : null,
        updatedAt: now,
      })
      .where(eq(tasksTable.id, taskId));
    emitTaskStatus(workspaceId, taskId, status, result);
    void this.captureOutcome(taskId, workspaceId, status, result, run, now);
  }

  private async captureOutcome(
    taskId: string,
    workspaceId: string,
    status: TaskStatus,
    result: TaskResult,
    run: FleetRun,
    finishedAt: Date,
  ): Promise<void> {
    try {
      const rows = await getDbClient()
        .select({
          type: tasksTable.type,
          createdAt: tasksTable.createdAt,
          metadata: tasksTable.metadata,
        })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .limit(1);
      const row = rows[0];
      if (!row) return;
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
      captureWorkspaceEvent(
        workspaceId,
        status === 'completed' ? 'task_completed' : 'task_failed',
        {
          task_id: taskId,
          task_type: row.type,
          provider: 'selfhosted',
          opened_pr: Boolean(meta.pullRequest || cloud?.prUrl),
          duration_total_ms: finishedAt.getTime() - new Date(row.createdAt).getTime(),
          // The fleet reports what the run actually cost. Note it is the SDK's
          // own client-side estimate, so it is for trend and attribution, not
          // for billing.
          ...(run.costUsd ? { cost_usd: run.costUsd } : {}),
          ...(result.error ? { error_reason: result.error } : {}),
        },
      );
    } catch {
      // Analytics must never affect task processing.
    }
  }
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

export const selfHostedPoller = new SelfHostedPoller();
