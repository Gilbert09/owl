import { eq } from 'drizzle-orm';
import type {
  AgentEvent,
  CloudTaskMetadata,
  TaskResult,
  TaskStatus,
} from '@talyn/shared';
import { readCloudTaskMeta } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate } from '../websocket.js';
import { linkTaskToPullRequest } from '../prCache.js';
import { clearWatched } from '../cloudProviders/taskWatch.js';
import { TranscriptCursors } from '../cloudProviders/transcriptStore.js';
import type { CloudTaskRow } from '../cloudProviders/types.js';
import { getClaudeCodeClient } from './credentials.js';
import {
  managedAgentEventsToAgentEvents,
  findPullRequestUrl,
  terminalStopReasonFromEvents,
  type ManagedAgentEvent,
} from './converter.js';

// Re-exported, not redeclared. This module and selfHosted/poller.ts each
// carried a byte-identical copy of the predicate, both constants, and the
// truncation below; a second definition of one rule is how they drift.
export { shouldPersistTranscript } from '../cloudProviders/transcriptStore.js';

/** The stop reasons we treat as "still working" rather than terminal. The
 *  vendor resumes a `pause_turn` (a long turn paused server-side) on its own. */
const NON_TERMINAL_STOP_REASONS = new Set(['pause_turn']);

/** Stop reasons that mean the run finished normally (vs. an abnormal cutoff
 *  like `max_tokens` / `refusal`). */
const NORMAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

/**
 * Whether a Managed Agents session has reached a state we should finalize on.
 * Sessions have no "completed" status: a finished run sits `idle` with a
 * terminal `stop_reason`, while a not-yet-started session is `idle` with none.
 * We accept ANY real stop_reason as terminal (keying only on `end_turn` left
 * runs that ended for any other reason stuck `in_progress`), except the
 * self-resuming `pause_turn`.
 */
export function isManagedSessionTerminal(session: {
  status?: string;
  stop_reason?: { type?: string } | null;
}): boolean {
  const stopType = session.stop_reason?.type ?? null;
  return session.status === 'idle' && !!stopType && !NON_TERMINAL_STOP_REASONS.has(stopType);
}

/**
 * A finished run is a success if it opened a PR, or stopped for a normal
 * reason. An abnormal stop with no PR (ran out of tokens, refused, …) is a
 * failure worth surfacing rather than a silent "completed".
 */
export function isManagedRunSuccess(stopType: string | null, hasPr: boolean): boolean {
  return hasPr || (stopType !== null && NORMAL_STOP_REASONS.has(stopType));
}

/**
 * Reconciles FastOwl tasks delegated to Claude Managed Agents. Anthropic owns
 * the agent loop in its sandbox; we poll each in-flight session, ingest its
 * events into the task transcript, link the PR it opens, and drive the local
 * task to `completed` / `failed`.
 *
 * Poll-based (the `/events/stream` endpoint only replays + closes), so unlike
 * the PostHog streamer there's no long-lived connection — `reconcileTask` does
 * the full job each tick.
 */
class ClaudeCodePoller {
  /** Emission + persistence bookkeeping, shared with every other provider. */
  private cursors = new TranscriptCursors();

  /** Entry point the generic cloud poller calls via the provider wrapper. */
  async reconcileTask(row: CloudTaskRow): Promise<void> {
    const cloud = readCloudTaskMeta({ metadata: row.metadata });
    if (!cloud || cloud.provider !== 'claude_code' || !cloud.remoteTaskId) return;
    const sessionId = cloud.remoteTaskId;

    const client = await getClaudeCodeClient(row.workspaceId);
    if (!client) return; // credentials removed mid-run; leave as-is.

    const session = await client.getSession(sessionId);
    const sessionStatus = session.status ?? null;

    // Fetch the event log when the run looks idle (either not-yet-started or
    // finished) or is being watched (live view). The session GET object very
    // often omits `stop_reason` even once a run has finished — the authoritative
    // terminal marker is the `session.status_idle` *event* — so we must consult
    // the events to finalize, not only after we already know it's terminal.
    // (Skipping the fetch for unwatched *running* runs keeps egress + token cost
    // down; an idle session is at most polled this way once before it finalizes.)
    let events: ManagedAgentEvent[] = [];
    let fetchedEvents = false;
    if (sessionStatus === 'idle' || row.watched) {
      try {
        events = await client.listEvents(sessionId);
        fetchedEvents = true;
      } catch (err) {
        console.warn(
          `[claudeCode] listEvents failed for task ${row.id.slice(0, 8)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Resolve the stop reason from the session object first, falling back to the
    // terminal `session.status_idle` event — the session GET frequently lacks it,
    // which previously left finished runs stuck `in_progress` forever.
    const stopType =
      (session.stop_reason?.type ?? null) || terminalStopReasonFromEvents(events);
    const terminal = isManagedSessionTerminal({
      status: sessionStatus ?? undefined,
      stop_reason: stopType ? { type: stopType } : null,
    });

    let prUrl = cloud.prUrl ?? null;
    if (fetchedEvents) {
      prUrl = findPullRequestUrl(events) ?? prUrl;
      // Force a final durable flush on the terminal tick; otherwise let the
      // debounce coalesce mid-run writes.
      await this.syncTranscript(row.id, row.workspaceId, events, terminal);
    }

    await patchTaskMetadata(row.id, (existing) => {
      const prev = (existing.cloudTask as CloudTaskMetadata | undefined) ?? cloud;
      return {
        ...existing,
        cloudTask: {
          ...prev,
          status: session.status ?? prev.status,
          prUrl: prUrl ?? prev.prUrl,
        },
      };
    });
    emitTaskUpdate(row.workspaceId, row.id, {
      metadata: { cloudTask: { status: session.status, prUrl: prUrl ?? undefined } },
    });

    if (!terminal) return;

    if (prUrl && row.repositoryId) {
      await this.linkPr(row.workspaceId, row.repositoryId, row.id, prUrl);
    }
    const success = isManagedRunSuccess(stopType, Boolean(prUrl));
    const result: TaskResult = success
      ? {
          success: true,
          summary: prUrl ? `Claude Code opened ${prUrl}` : 'Claude Code run completed',
        }
      : {
          success: false,
          summary: `Claude Code stopped without opening a PR (stop reason: ${stopType})`,
          error: `Run ended with stop reason "${stopType}"`,
        };
    await this.finalize(row.id, row.workspaceId, success ? 'completed' : 'failed', result);

    // Best-effort cleanup of the per-dispatch vault (held the GitHub token).
    const vaultId = cloud.extra?.vaultId as string | undefined;
    if (vaultId) {
      await client.deleteVault(vaultId).catch(() => {
        /* vault may already be gone; harmless */
      });
    }
  }

  /** Poll-based: rebuild the transcript from the full event log, persist + emit
   *  only what's new (seq = stable index). No-op when nothing changed. */
  private async syncTranscript(
    taskId: string,
    workspaceId: string,
    rawEvents: ManagedAgentEvent[],
    force: boolean,
  ): Promise<void> {
    const inputs = managedAgentEventsToAgentEvents(rawEvents);
    const transcript: AgentEvent[] = inputs.map((input, i) => ({ ...input, seq: i }) as AgentEvent);

    // Live path: emit anything past the WS cursor every tick, cheaply.
    this.cursors.emitNew(taskId, workspaceId, transcript);
    // Durable path: skip the full-array rewrite when the DB is already current,
    // or when the debounce window hasn't elapsed (unless forced at terminal).
    await this.cursors.persistIfDue(taskId, transcript, { force });
  }

  /** Drop the in-memory transcript cursors for a task (stop/delete). */
  stopStreaming(taskId: string): void {
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
    const db = getDbClient();
    const repoRows = await db
      .select({ defaultBranch: repositoriesTable.defaultBranch })
      .from(repositoriesTable)
      .where(eq(repositoriesTable.id, repositoryId))
      .limit(1);
    const baseBranch = repoRows[0]?.defaultBranch || 'main';
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
        baseBranch,
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
        `[claudeCode] failed to link PR for task ${taskId.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async finalize(
    taskId: string,
    workspaceId: string,
    status: TaskStatus,
    result: TaskResult,
  ): Promise<void> {
    this.cursors.forget(taskId);
    clearWatched(taskId);
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
    void this.captureOutcome(taskId, workspaceId, status, result, now);
  }

  private async captureOutcome(
    taskId: string,
    workspaceId: string,
    status: TaskStatus,
    result: TaskResult,
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
          provider: 'claude_code',
          opened_pr: Boolean(meta.pullRequest || cloud?.prUrl),
          duration_total_ms: finishedAt.getTime() - new Date(row.createdAt).getTime(),
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

export const claudeCodePoller = new ClaudeCodePoller();
