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
import { TranscriptCursors } from '../cloudProviders/transcriptStore.js';
import type { CloudTaskRow } from '../cloudProviders/types.js';
import { getSelfHostedClient } from './credentials.js';
import type { FleetClient, FleetEvent, FleetRun } from './client.js';

// Re-exported, not redeclared. This module and claudeCode/poller.ts each had a
// byte-identical copy of the predicate and the two constants behind it; a
// second definition of one rule is how they drift.
export { shouldPersistTranscript } from '../cloudProviders/transcriptStore.js';

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
  /** taskId → the live SSE follow, when one is open. */
  private follows = new Map<string, AbortController>();
  /** taskId → transcript accumulated this process lifetime. */
  private transcripts = new Map<string, AgentEvent[]>();
  /** Emission + persistence bookkeeping, shared with every other provider. */
  private cursors = new TranscriptCursors();

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

    // For a task somebody is actually watching, also open a live stream. The
    // poll above still runs and is still what finalises the task — this only
    // shortens the latency from "up to one poll interval" to "as fast as the
    // guest emits". If the stream never opens or dies mid-run, nothing breaks:
    // the poll is holding the same cursor.
    if (row.watched && !terminal) this.ensureFollow(row, client, runId);
    if (terminal) this.stopFollow(row.id);

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

    // The fleet's seq is authoritative and monotonic; reuse it rather than
    // re-indexing, so a transcript survives a backend restart mid-run with its
    // numbering intact. `ingest` also drops anything the live stream already
    // delivered, which is what lets both run at once.
    this.ingest(row, fetched);
    await this.cursors.persistIfDue(row.id, this.transcripts.get(row.id) ?? [], { force });
  }

  /**
   * Open a live transcript stream, if one is not already running.
   *
   * Deliberately fire-and-forget. The stream is an optimisation over the poll,
   * so awaiting it here would make the reconcile tick block on a connection
   * that is designed to stay open for the life of the run.
   */
  private ensureFollow(
    row: CloudTaskRow,
    client: { followEvents: FleetClient['followEvents'] },
    runId: string,
  ): void {
    if (this.follows.has(row.id)) return;
    const abort = new AbortController();
    this.follows.set(row.id, abort);

    void (async () => {
      try {
        const after = this.cursor.get(row.id) ?? 0;
        for await (const frame of client.followEvents(runId, after, abort.signal)) {
          this.ingest(row, frame.events);
          if (frame.terminal) break;
        }
      } catch (err) {
        // Never surface this. A dropped stream is a latency regression, not a
        // failed run, and the poll underneath is unaffected — treating it as an
        // error would turn a slow transcript into a failed task.
        if (!abort.signal.aborted) {
          console.warn(
            `[selfhosted] transcript stream for ${row.id.slice(0, 8)} ended:`,
            err instanceof Error ? err.message : err,
          );
        }
      } finally {
        // Only clear if this is still the current stream: a stopStreaming that
        // raced a reconnect would otherwise delete somebody else's controller.
        if (this.follows.get(row.id) === abort) this.follows.delete(row.id);
      }
    })();
  }

  private stopFollow(taskId: string): void {
    this.follows.get(taskId)?.abort();
    this.follows.delete(taskId);
  }

  /**
   * Append events and emit them, skipping anything already seen.
   *
   * Shared by the poll and the stream, which is what makes running both at once
   * safe: the fleet's `seq` is authoritative and monotonic, so whichever gets a
   * given event first wins and the other drops it. Without this the two would
   * double-emit every event to the desktop.
   */
  private ingest(row: CloudTaskRow, events: FleetEvent[]): void {
    const transcript = this.transcripts.get(row.id) ?? [];
    let advanced = false;
    for (const ev of events) {
      if (ev.seq <= (this.cursor.get(row.id) ?? 0)) continue;
      transcript.push({ ...(ev.event as object), seq: ev.seq } as AgentEvent);
      this.cursor.set(row.id, ev.seq);
      emitTaskEvent(row.workspaceId, row.id, transcript[transcript.length - 1]);
      advanced = true;
    }
    if (advanced) this.transcripts.set(row.id, transcript);
  }

  /** Drop the in-memory cursors for a task (stop/delete). */
  stopStreaming(taskId: string): void {
    this.stopFollow(taskId);
    this.cursor.delete(taskId);
    this.transcripts.delete(taskId);
    this.cursors.forget(taskId);
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
