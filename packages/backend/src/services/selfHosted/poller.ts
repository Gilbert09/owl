import { eq } from 'drizzle-orm';
import type { AgentEvent, CloudTaskMetadata, TaskResult, TaskStatus } from '@talyn/shared';
import { readCloudTaskMeta, readCloudTaskProvider } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable, repositories as repositoriesTable } from '../../db/schema.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate, emitTaskEvent } from '../websocket.js';
import { linkTaskToPullRequest } from '../prCache.js';
import { clearWatched } from '../cloudProviders/taskWatch.js';
import { TranscriptCursors } from '../cloudProviders/transcriptStore.js';
import type { CloudTaskRow } from '../cloudProviders/types.js';
import { githubService } from '../github.js';
import { getSelfHostedClient, getSelfHostedCredentials } from './credentials.js';
import { FleetRunNotFoundError } from './client.js';
import type { FleetClient, FleetEvent, FleetRun } from './client.js';

// Re-exported, not redeclared. This module and claudeCode/poller.ts each had a
// byte-identical copy of the predicate and the two constants behind it; a
// second definition of one rule is how they drift.
export { shouldPersistTranscript } from '../cloudProviders/transcriptStore.js';

/**
 * How long a task may be `in_progress` with no fleet run before it is failed.
 *
 * Five minutes: long enough that no dispatch in flight could still be inside it
 * (the executor's own request timeout is twenty seconds), short enough that a
 * task nobody will ever finish stops claiming to be running within one coffee.
 */
export const DISPATCH_GRACE_MS = 5 * 60_000;

/** A fleet run is terminal exactly when the fleet says so — it owns the
 *  lifecycle and reports one of three end states. */
export function isFleetRunTerminal(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Map a fleet outcome onto a local task status.
 *
 * `cancelled` used to collapse into `failed` on the grounds that "the local
 * model has no cancelled state for a cloud run". It does — `TaskStatus`
 * carries `cancelled`, and Session 52 established that an aborted cloud run
 * lands there rather than in `failed`. The self-hosted provider simply never
 * got that mapping.
 *
 * It is not cosmetic. Five of the twenty-one failed fleet tasks on record were
 * cancelled runs, so a quarter of the failure count described something that
 * had not failed — and every one of those five was reaped by fleetd's wedge
 * detector, which is a distinct problem that the `failed` label hid rather than
 * surfaced. Keeping the two apart is what makes the failure count mean
 * something.
 */
export function taskStatusForFleetRun(status: string | undefined): TaskStatus {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

/**
 * Unwrap the fleet's envelope into the shape the transcript renderer reads.
 *
 * The fleet WRAPS each event as `{type, subtype, raw, guestSeq}`, where `raw` is
 * the Agent SDK message itself and the outer `type`/`subtype` are copies fleetd
 * probed out of it so it can index without parsing the payload.
 *
 * `AgentEvent` — what every other provider produces and what the renderer reads
 * — carries the SDK message AT THE TOP LEVEL: `message`, `content`, `result`.
 * Spreading the wrapper put all of that one level down under `raw`, so a
 * transcript looked structurally fine and rendered as nothing: a task sat on
 * "Claude is thinking..." while 47 events were already in Postgres.
 *
 * Worth stating plainly, because the symptom was indistinguishable from the
 * three other causes chased before it (a tailnet MTU black hole, NUL bytes the
 * jsonb column refused, a stale fleet build). Every layer reported success and
 * the payload was present at every hop. Only the shape was wrong, and nothing
 * type-checks a jsonb column.
 *
 * Falls back to the event itself when there is no `raw`, so an older fleet that
 * does not wrap still ingests rather than producing empty entries.
 */
export function toAgentEvent(ev: FleetEvent): AgentEvent {
  const wrapper = ev.event as { raw?: unknown } | undefined;
  const payload = (wrapper?.raw ?? ev.event ?? {}) as object;
  return { ...payload, seq: ev.seq } as AgentEvent;
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
  /**
   * taskId → the `adoptedAt` we last re-credentialed that run for.
   *
   * Keyed on the adoption, not the task. This was a bare `Set<string>` of task
   * ids — "do it once" — and once is wrong: credentials live in the fleetd
   * process's memory, so EVERY restart loses them again, and a run adopted a
   * second time found its id already in the set and was skipped forever. Run
   * 98c9698a on 2026-08-05 was re-credentialed on its first adoption at 11:19,
   * silently skipped on its second at 11:52, and spent the next eighteen
   * minutes failing every LLM call before being reported as
   * "guest did not reconnect".
   *
   * fleetd now also pulls its own credentials at adoption, which is the primary
   * repair; this stays correct as the eager path rather than the only one.
   */
  private recredentialed = new Map<string, string>();

  /** Entry point the generic cloud poller calls via the provider seam. */
  async reconcileTask(row: CloudTaskRow): Promise<void> {
    // Read the provider from the metadata rather than from the cloud envelope,
    // because a task with NO remote run has no envelope to read it off — and
    // that task is exactly the one this method used to walk away from.
    if (readCloudTaskProvider({ metadata: row.metadata }) !== 'selfhosted') return;

    const cloud = readCloudTaskMeta({ metadata: row.metadata });
    if (!cloud?.remoteTaskId) {
      await this.failUndispatched(row);
      return;
    }
    const runId = cloud.remoteTaskId;

    const client = await getSelfHostedClient(row.workspaceId);
    if (!client) return; // credentials removed mid-run; leave the task as-is.

    // Any error here (including the capacity/throttle types) propagates to the
    // generic poller, which logs it and retries next tick. A failed poll must
    // never fail the task — the run is still going on the metal.
    //
    // The exception is a reachable host telling us the run does not exist. That
    // is terminal: the VM is gone (fleetd restarted without adopting it, or it
    // was reclaimed) and no future tick can change the answer. Retrying it is an
    // infinite loop — two tasks sat in it for 21 hours on 2026-08-06, filling the
    // log with one identical failure per tick while the host sat idle.
    let run: FleetRun;
    try {
      ({ run } = await client.getRun(runId));
    } catch (err) {
      if (err instanceof FleetRunNotFoundError) {
        await this.failVanishedRun(row, runId, err.message);
        return;
      }
      throw err;
    }
    const terminal = isFleetRunTerminal(run.status);

    // An ADOPTED run survived a fleetd restart, but its credentials did not:
    // the fleet holds them only in memory, deliberately, so the surviving VM
    // cannot authenticate anything until somebody hands them back. We are the
    // only party that still has them.
    //
    // Done before the transcript sync so the run is working again as early in
    // this tick as possible — every second it spends un-credentialed is a
    // second of its deadline spent on requests that will 502.
    if (run.adopted && !terminal) {
      await this.recredential(row, client, runId, run.adoptedAt);
    }

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
   * Re-supply an adopted run's credentials.
   *
   * Best effort and deliberately non-fatal: if this fails the run is no worse
   * off than before, and the next tick tries again. Throwing here would fail a
   * reconcile — and therefore stop the transcript sync — over something that is
   * already broken and that we are trying to repair.
   */
  private async recredential(
    row: CloudTaskRow,
    client: FleetClient,
    runId: string,
    adoptedAt: string | undefined,
  ): Promise<void> {
    // The guard is per ADOPTION. A fleetd with no `adoptedAt` on the wire is an
    // older build, and there the safe reading of "unknown" is "not the one we
    // already did" — re-supplying twice is harmless (it writes the same
    // credentials into the same proxy) whereas skipping leaves the run blind.
    const key = adoptedAt ?? '';
    if (adoptedAt && this.recredentialed.get(row.id) === key) return;
    try {
      const githubToken = githubService.getAccessToken(row.workspaceId);
      const creds = await getSelfHostedCredentials(row.workspaceId);
      if (!githubToken || !creds) {
        // Silent returns here were invisible for two sessions: the run went on
        // failing every LLM call and nothing said why.
        console.warn(
          `[selfhosted] cannot re-supply credentials to ${runId}: ` +
            `${!githubToken ? 'no GitHub token' : 'no Anthropic credential'} for workspace ${row.workspaceId}`,
        );
        return;
      }
      const repo = (readCloudTaskMeta({ metadata: row.metadata })?.extra as { repo?: string })?.repo;
      await client.setRunCredentials(runId, {
        githubToken,
        anthropicKey: creds.claudeToken,
        ...(repo ? { repo } : {}),
      });
      // Marked only on success, so a failed attempt is retried next tick.
      this.recredentialed.set(row.id, key);
      console.log(`[selfhosted] re-supplied credentials to adopted run ${runId}`);
    } catch (err) {
      console.warn(
        `[selfhosted] could not re-supply credentials to ${runId}:`,
        err instanceof Error ? err.message : err,
      );
    }
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
      transcript.push(toAgentEvent(ev));
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
    this.recredentialed.delete(taskId);
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

  /**
   * Fail a task that is in progress and has no remote run at all.
   *
   * # Why nothing was reconciling these
   *
   * Every branch of this reconcile needs a run id, so the entry point returned
   * early when there was none. That early return is correct for a task that is
   * not ours; for a task that IS ours and says `in_progress`, it is the poller
   * declining to look at the only tasks it could still help. Two of them sat in
   * that state indefinitely — "Get PostHog/posthog#70991 mergeable" and "#74692"
   * — with no run on any host, no log line, and nothing that would ever move
   * them. A task nobody will finish must not present as a task in progress.
   *
   * # Why a grace period, when the write order already looks safe
   *
   * The executor writes `cloudTask.remoteTaskId` BEFORE it flips the task to
   * `in_progress` (executor.ts), so in principle a task cannot be seen as
   * running before its run id exists. The grace period does not assume that
   * holds: the two writes are separate statements, `patchTaskMetadata`
   * serialises through its own mutex, and a poll tick that landed between them
   * would fail a task whose agent was starting perfectly well. Costing a stuck
   * task five extra minutes is nothing; killing a healthy run is not.
   *
   * Failed rather than requeued, deliberately. Requeueing would dispatch work
   * the user asked for once and has not looked at since — possibly hours ago,
   * possibly against a branch that has moved — and it would do so from a code
   * path that does not know WHY the dispatch was lost. Failing states the
   * position honestly and leaves the retry to the person who wanted it.
   */
  private async failUndispatched(row: CloudTaskRow): Promise<void> {
    // Only in-flight tasks. The generic poller also loads completed revival
    // candidates and completed tasks awaiting a transcript backfill, and
    // neither has any business being failed by this branch — one of them is a
    // finished task whose transcript is merely late.
    if (row.status !== 'in_progress') return;

    const startedAt = row.updatedAt?.getTime();
    if (startedAt !== undefined && Date.now() - startedAt < DISPATCH_GRACE_MS) return;

    this.stopStreaming(row.id);
    clearWatched(row.id);
    this.cursor.delete(row.id);

    const summary =
      'This task never reached the fleet: it is marked in progress but carries no run, ' +
      'so no host is working on it and nothing can report back. Retry it to dispatch a fresh run.';
    const result: TaskResult = {
      success: false,
      summary,
      error: 'task is in_progress with no cloudTask.remoteTaskId; the dispatch did not complete',
    };

    await getDbClient()
      .update(tasksTable)
      .set({ status: 'failed', result, completedAt: null, updatedAt: new Date() })
      .where(eq(tasksTable.id, row.id));

    // The cloud status too, for the same reason failVanishedRun stamps it: the
    // operator console falls back to this metadata when there is no live run,
    // and a row left saying `running` keeps offering a Cancel button that can
    // only ever error.
    await patchTaskMetadata(row.id, (existing) => {
      const prev = (existing.cloudTask as CloudTaskMetadata | undefined) ?? undefined;
      return { ...existing, cloudTask: { ...(prev ?? {}), status: 'failed' } };
    });

    emitTaskStatus(row.workspaceId, row.id, 'failed', result);
    console.warn(
      `[selfhosted] task ${row.id.slice(0, 8)}: in_progress with no fleet run — failing it`,
    );
  }

  /**
   * Fail a task whose run no longer exists on the host.
   *
   * Deliberately not routed through `finalize`, which needs a FleetRun to derive
   * status and summary from — there is no run to describe. The summary names the
   * cause, because "Fleet run ended failed" would send someone looking for a
   * failure on the metal that never happened.
   */
  private async failVanishedRun(
    row: CloudTaskRow,
    runId: string,
    detail: string,
  ): Promise<void> {
    this.stopStreaming(row.id);
    clearWatched(row.id);
    this.cursor.delete(row.id);

    const summary =
      'The fleet host no longer has this run — it was lost when the host restarted ' +
      'or the sandbox was reclaimed. Retry the task to start a fresh run.';
    const result: TaskResult = { success: false, summary, error: `run ${runId} not found: ${detail}` };

    const now = new Date();
    await getDbClient()
      .update(tasksTable)
      .set({ status: 'failed', result, completedAt: null, updatedAt: now })
      .where(eq(tasksTable.id, row.id));

    // Stamp the CLOUD status too, not just the task's own.
    //
    // The operator console's run list reads `run?.status ?? task.cloudStatus`
    // (services/admin/runIndex.ts): with the run gone from the host there is no
    // live status, so it falls through to this metadata — which every normal
    // reconcile keeps fresh from the run, and which a vanished run leaves frozen
    // at whatever it last said. Updating only `tasks.status` left the Runs page
    // showing two rows as `queued` and `running` for 32 hours after they had
    // already been failed, with a Cancel button that could only ever error.
    await patchTaskMetadata(row.id, (existing) => {
      const prev = (existing.cloudTask as CloudTaskMetadata | undefined) ?? undefined;
      return {
        ...existing,
        cloudTask: { ...(prev ?? {}), status: 'failed' },
      };
    });

    emitTaskStatus(row.workspaceId, row.id, 'failed', result);
    console.warn(
      `[selfhosted] task ${row.id.slice(0, 8)}: run ${runId.slice(0, 8)} is gone — failing it (${detail})`,
    );
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
