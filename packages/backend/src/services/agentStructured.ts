import { EventEmitter } from 'events';
import { eq } from 'drizzle-orm';
import type { AgentEvent } from '@fastowl/shared';
import { getDbClient, type Database } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import { environmentService } from './environment.js';
import {
  emitAgentEvent,
  emitTaskEvent,
  emitAgentPermissionRequest,
  emitAgentPermissionResponse,
} from './websocket.js';
import { permissionService, type PendingRequest } from './permissionService.js';

/**
 * Per-task upper bound on the persisted transcript. Keeps a runaway
 * autonomous task from growing `tasks.transcript` without limit. When
 * we exceed this we keep the first 100 events (for context) and the
 * last `TRANSCRIPT_MAX - 100` (for the live tail), with a single
 * `[truncated]` marker in between.
 */
const TRANSCRIPT_MAX_EVENTS = 2000;
const TRANSCRIPT_PERSIST_EVERY = 25; // events

export interface StructuredRunOptions {
  sessionKey: string;
  agentId: string;
  environmentId: string;
  workspaceId: string;
  taskId?: string;
  cwd?: string;
  /** Seed message (optional for interactive mode — user can type it instead). */
  prompt?: string;
  /**
   * `bypass` => `--permission-mode bypassPermissions` (no prompts at all).
   * `strict` => `--permission-mode default` with our PreToolUse hook
   * driving the Approve/Deny flow.
   */
  permissionMode: 'bypass' | 'strict';
  /**
   * Absolute path to the fastowl PreToolUse hook script. Required when
   * `permissionMode === 'strict'`; ignored otherwise.
   */
  hookScriptPath?: string;
  /**
   * `true` ⇒ open-ended conversation. Uses `--input-format stream-json`
   * and keeps stdin open after the seed prompt so the user can `sendMessage`
   * more turns. The child exits when stdin is closed (via `closeInput`)
   * or killed (via `stop`).
   *
   * `false` ⇒ one-shot. Seed prompt goes in on stdin, stdin closes
   * immediately, child exits after the first turn. Matches Slice 1/2
   * behaviour for autonomous backlog runs.
   */
  interactive?: boolean;
  /**
   * When set, resume the CLI's saved session (`--resume <id>`) and
   * deliver `prompt` as the next user turn. Session files live under
   * `~/.claude/projects/<encoded-cwd>/<id>.jsonl` on whichever host
   * the CLI originally ran on. If unset, the CLI creates a fresh
   * session and we capture its id from the `system/init` event.
   */
  resumeSessionId?: string;
  /** Forward these env vars to the child. */
  env?: Record<string, string>;
  /** Allow callers to override the binary (tests). */
  claudeBinary?: string;
}

export interface ActiveStructuredRun {
  sessionKey: string;
  agentId: string;
  environmentId: string;
  taskId?: string;
  workspaceId: string;
  /** True if stdin stays open after the seed prompt for follow-up turns. */
  interactive: boolean;
  /** In-memory transcript; persisted in batches to `tasks.transcript`. */
  transcript: AgentEvent[];
  startedAt: Date;
  /** Resolves with the final exit code once the underlying child exits. */
  completion: Promise<number>;
  /** Per-run token presented by the child's PreToolUse hook. */
  permissionToken?: string;
  /**
   * CLI-assigned session id (from the `system/init` event), captured
   * once per run. Persisted on `task.metadata.claudeSessionId` so a
   * later `/continue` can `--resume` this conversation with a new
   * prompt after the child has exited.
   */
  claudeSessionId?: string;
  /** Cleanup for permissionService listeners scoped to this run. */
  detachPermissionListeners?: () => void;
  /** Cleanup for environmentService listeners scoped to this session. */
  detachTransportListeners?: () => void;
}

/**
 * Drives the `claude -p --output-format stream-json --verbose` pipeline.
 * Parses JSONL events off the session's stdout, broadcasts them as
 * structured WS messages, and persists a bounded transcript on
 * `tasks.transcript`.
 *
 * Transport is pluggable via `environmentService.spawnStreaming` —
 * local envs spawn in-process, daemon envs tunnel through the WS
 * wire protocol, SSH envs (Slice 4b) go over an ssh2 exec channel.
 * The service itself doesn't care which.
 */
class AgentStructuredService extends EventEmitter {
  private runs: Map<string, ActiveStructuredRun> = new Map();

  private get db(): Database {
    return getDbClient();
  }

  /** True if there's a live structured run on this session key. */
  has(sessionKey: string): boolean {
    return this.runs.has(sessionKey);
  }

  /**
   * Kill a live run. Completion handlers still fire with whatever
   * exit code the child produces (typically 143 from SIGTERM).
   */
  stop(sessionKey: string): void {
    const run = this.runs.get(sessionKey);
    if (!run) return;
    environmentService.killSession(sessionKey);
  }

  /**
   * Send a user message to a live interactive run. Appends a
   * stream-json `{type: "user", ...}` envelope to the child's stdin;
   * the CLI processes it as the next turn.
   *
   * Throws if the run isn't interactive (one-shot runs close stdin
   * immediately after the seed prompt).
   */
  sendMessage(sessionKey: string, text: string): void {
    const run = this.runs.get(sessionKey);
    if (!run) throw new Error(`no active structured run for ${sessionKey}`);
    if (!run.interactive) {
      throw new Error(`run ${sessionKey} is one-shot; sendMessage only works in interactive mode`);
    }
    const envelope = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    });
    environmentService.writeToSession(sessionKey, envelope + '\n');
  }

  /**
   * Gracefully end an interactive session by closing the child's
   * stdin. The CLI finalises the current turn (if any) and exits with
   * code 0 — so the task transitions to `awaiting_review`, not
   * `failed`. Prefer this over `stop()` for "user clicked end
   * conversation" flows.
   */
  closeInput(sessionKey: string): void {
    void environmentService.closeStreamInput(sessionKey).catch(() => {});
  }

  /**
   * Spawn a structured run via the env service. Returns once the
   * child is live; callers can await `run.completion` for the exit
   * code.
   */
  async start(opts: StructuredRunOptions): Promise<ActiveStructuredRun> {
    if (this.runs.has(opts.sessionKey)) {
      throw new Error(`structured run already active for ${opts.sessionKey}`);
    }

    const args = buildClaudeArgs(opts);
    const binary = opts.claudeBinary ?? 'claude';

    // For strict mode, mint a per-run permission token so the child's
    // hook can authenticate itself back to the backend without a user
    // JWT. Token is in-process-only; never touches disk.
    let permissionToken: string | undefined;
    const childEnv: Record<string, string> = { ...(opts.env ?? {}) };
    if (opts.permissionMode === 'strict') {
      permissionToken = permissionService.registerRun({
        agentId: opts.agentId,
        environmentId: opts.environmentId,
        workspaceId: opts.workspaceId,
        taskId: opts.taskId,
      });
      childEnv.FASTOWL_PERMISSION_TOKEN = permissionToken;
      childEnv.FASTOWL_AGENT_ID = opts.agentId;
    }

    // Seed-stdin bytes.
    //   - Interactive: wrap as stream-json envelope; stdin stays open.
    //   - One-shot: write raw text (CLI's text input mode); stdin
    //     closes immediately so the child exits after the first turn.
    let initialStdin: string | undefined;
    if (opts.prompt) {
      initialStdin = opts.interactive
        ? JSON.stringify({ type: 'user', message: { role: 'user', content: opts.prompt } }) + '\n'
        : opts.prompt;
    }

    // Wire transport listeners BEFORE spawning so we don't miss any
    // early output. environmentService emits per-session events
    // globally — we filter by sessionKey.
    const parser = new JsonlLineParser();
    let resolveCompletion!: (code: number) => void;
    const completion = new Promise<number>((resolve) => {
      resolveCompletion = resolve;
    });

    const onData = (sid: string, chunk: Buffer) => {
      if (sid !== opts.sessionKey) return;
      for (const rawEvent of parser.push(chunk.toString('utf-8'))) {
        void this.onRawEvent(run, rawEvent).catch((err) =>
          console.error(`[agentStructured ${opts.sessionKey}] onRawEvent failed:`, err)
        );
      }
    };
    const onStderr = (sid: string, chunk: Buffer) => {
      if (sid !== opts.sessionKey) return;
      void this.onRawEvent(run, {
        type: 'system',
        subtype: 'stderr',
        text: chunk.toString('utf-8'),
      });
    };
    const onClose = (sid: string, code: number) => {
      if (sid !== opts.sessionKey) return;
      this.runs.delete(opts.sessionKey);
      run.detachPermissionListeners?.();
      run.detachTransportListeners?.();
      if (permissionToken) permissionService.unregisterRun(permissionToken);
      resolveCompletion(code);
      this.emit('exit', run, code);
    };
    environmentService.on('session:data', onData);
    environmentService.on('session:stderr', onStderr);
    environmentService.on('session:close', onClose);
    const detachTransportListeners = () => {
      environmentService.off('session:data', onData);
      environmentService.off('session:stderr', onStderr);
      environmentService.off('session:close', onClose);
    };

    const run: ActiveStructuredRun = {
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
      environmentId: opts.environmentId,
      taskId: opts.taskId,
      workspaceId: opts.workspaceId,
      interactive: Boolean(opts.interactive),
      transcript: [],
      startedAt: new Date(),
      permissionToken,
      completion,
      detachTransportListeners,
    };
    this.runs.set(opts.sessionKey, run);

    // Bridge permissionService → transcript. Only care about events
    // for our run's agentId; permissionService emits globally.
    const onRequest = (pending: PendingRequest) => {
      if (pending.agentId !== run.agentId) return;
      emitAgentPermissionRequest(run.workspaceId, {
        requestId: pending.requestId,
        agentId: pending.agentId,
        taskId: pending.taskId,
        toolName: pending.toolName,
        toolInput: pending.toolInput,
        toolUseId: pending.toolUseId,
        sessionId: pending.sessionId,
        requestedAt: pending.requestedAt,
      });
      void this.onRawEvent(run, {
        type: 'fastowl_permission_request',
        requestId: pending.requestId,
        tool_name: pending.toolName,
        tool_input: pending.toolInput,
        tool_use_id: pending.toolUseId,
        session_id: pending.sessionId,
        requested_at: pending.requestedAt,
      });
    };
    const onAutoAllowed = (ev: {
      requestId: string;
      agentId: string;
      taskId?: string;
      toolName: string;
      toolInput: unknown;
      toolUseId?: string;
      sessionId?: string;
      requestedAt: string;
    }) => {
      if (ev.agentId !== run.agentId) return;
      void this.onRawEvent(run, {
        type: 'fastowl_permission_auto_allowed',
        requestId: ev.requestId,
        tool_name: ev.toolName,
        tool_input: ev.toolInput,
        tool_use_id: ev.toolUseId,
        session_id: ev.sessionId,
        requested_at: ev.requestedAt,
      });
    };
    const onResolved = (ev: {
      requestId: string;
      decision: 'allow' | 'deny';
      persist: boolean;
      agentId: string;
      taskId?: string;
      toolName: string;
    }) => {
      if (ev.agentId !== run.agentId) return;
      emitAgentPermissionResponse(run.workspaceId, {
        requestId: ev.requestId,
        decision: ev.decision,
        persist: ev.persist,
        agentId: ev.agentId,
        taskId: ev.taskId,
      });
      void this.onRawEvent(run, {
        type: 'fastowl_permission_response',
        requestId: ev.requestId,
        decision: ev.decision,
        persist: ev.persist,
        tool_name: ev.toolName,
      });
    };
    permissionService.on('request', onRequest);
    permissionService.on('auto_allowed', onAutoAllowed);
    permissionService.on('resolved', onResolved);
    run.detachPermissionListeners = () => {
      permissionService.off('request', onRequest);
      permissionService.off('auto_allowed', onAutoAllowed);
      permissionService.off('resolved', onResolved);
    };

    try {
      await environmentService.spawnStreaming(
        opts.environmentId,
        opts.sessionKey,
        binary,
        args,
        {
          cwd: opts.cwd,
          env: childEnv,
          keepStdinOpen: Boolean(opts.interactive),
          initialStdin,
        }
      );
    } catch (err) {
      // Spawn failed before the child ever existed — emit a synthetic
      // error event, tear down listeners, and resolve completion with
      // a non-zero code so the caller's handleStructuredExit marks
      // the task `failed`.
      this.runs.delete(opts.sessionKey);
      run.detachPermissionListeners?.();
      run.detachTransportListeners?.();
      if (permissionToken) permissionService.unregisterRun(permissionToken);
      const message = err instanceof Error ? err.message : String(err);
      await this.onRawEvent(run, {
        type: 'system',
        subtype: 'spawn_error',
        text: message,
      });
      resolveCompletion(1);
    }

    return run;
  }

  /**
   * Adopt a structured run whose child was spawned by a *prior* backend
   * process and is still alive under the daemon. Used by
   * `agent.cleanupStaleAgents` after a backend restart: the child's
   * `session:data`/`session:close` events are already flowing from the
   * daemon — we just need to resubscribe, parse into transcript events,
   * and map exit onto the usual task lifecycle.
   *
   * Differences from `start()`:
   *   - No spawn. The child exists; we only listen.
   *   - No `permissionToken`: the child was seeded with a token
   *     registered in the previous backend's permissionService, which
   *     is gone. Permission prompts from this run will fail if they
   *     fire (rare — the child has to be mid-PreToolUse at restart).
   *     The prompt on the daemon side will timeout.
   *   - Transcript is pre-loaded from `tasks.transcript` so new events
   *     stamp correctly-ordered `seq` values.
   */
  async resumeRun(opts: {
    sessionKey: string;
    agentId: string;
    environmentId: string;
    workspaceId: string;
    taskId?: string;
    interactive: boolean;
  }): Promise<ActiveStructuredRun> {
    if (this.runs.has(opts.sessionKey)) {
      throw new Error(`structured run already active for ${opts.sessionKey}`);
    }

    // Preload transcript from DB so new events pick up the right seq.
    let transcript: AgentEvent[] = [];
    if (opts.taskId) {
      const rows = await this.db
        .select({ transcript: tasksTable.transcript })
        .from(tasksTable)
        .where(eq(tasksTable.id, opts.taskId))
        .limit(1);
      if (rows[0]?.transcript) {
        transcript = rows[0].transcript as AgentEvent[];
      }
    }

    const parser = new JsonlLineParser();
    let resolveCompletion!: (code: number) => void;
    const completion = new Promise<number>((resolve) => {
      resolveCompletion = resolve;
    });

    const onData = (sid: string, chunk: Buffer) => {
      if (sid !== opts.sessionKey) return;
      for (const rawEvent of parser.push(chunk.toString('utf-8'))) {
        void this.onRawEvent(run, rawEvent).catch((err) =>
          console.error(`[agentStructured ${opts.sessionKey}] onRawEvent failed:`, err)
        );
      }
    };
    const onStderr = (sid: string, chunk: Buffer) => {
      if (sid !== opts.sessionKey) return;
      void this.onRawEvent(run, {
        type: 'system',
        subtype: 'stderr',
        text: chunk.toString('utf-8'),
      });
    };
    const onClose = (sid: string, code: number) => {
      if (sid !== opts.sessionKey) return;
      this.runs.delete(opts.sessionKey);
      run.detachPermissionListeners?.();
      run.detachTransportListeners?.();
      resolveCompletion(code);
      this.emit('exit', run, code);
    };
    environmentService.on('session:data', onData);
    environmentService.on('session:stderr', onStderr);
    environmentService.on('session:close', onClose);
    const detachTransportListeners = () => {
      environmentService.off('session:data', onData);
      environmentService.off('session:stderr', onStderr);
      environmentService.off('session:close', onClose);
    };

    const run: ActiveStructuredRun = {
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
      environmentId: opts.environmentId,
      taskId: opts.taskId,
      workspaceId: opts.workspaceId,
      interactive: opts.interactive,
      transcript,
      // Best-effort — we don't know when the real spawn happened, but
      // this is only surfaced in UI timing displays.
      startedAt: new Date(),
      completion,
      detachTransportListeners,
    };
    this.runs.set(opts.sessionKey, run);

    // Permission bridge is a pure UI-layer broadcast; it works even
    // though we can't mint a new token for the child. If the child's
    // old token fires a hook request, permissionService rejects it
    // silently — users see no permission prompt, the daemon side times
    // out and the child gets a "deny" back. Acceptable for the
    // narrow "restart mid-PreToolUse" case.
    const onRequest = (pending: PendingRequest) => {
      if (pending.agentId !== run.agentId) return;
      emitAgentPermissionRequest(run.workspaceId, {
        requestId: pending.requestId,
        agentId: pending.agentId,
        taskId: pending.taskId,
        toolName: pending.toolName,
        toolInput: pending.toolInput,
        toolUseId: pending.toolUseId,
        sessionId: pending.sessionId,
        requestedAt: pending.requestedAt,
      });
      void this.onRawEvent(run, {
        type: 'fastowl_permission_request',
        requestId: pending.requestId,
        tool_name: pending.toolName,
        tool_input: pending.toolInput,
        tool_use_id: pending.toolUseId,
        session_id: pending.sessionId,
        requested_at: pending.requestedAt,
      });
    };
    const onResolved = (ev: {
      requestId: string;
      decision: 'allow' | 'deny';
      persist: boolean;
      agentId: string;
      taskId?: string;
      toolName: string;
    }) => {
      if (ev.agentId !== run.agentId) return;
      emitAgentPermissionResponse(run.workspaceId, {
        requestId: ev.requestId,
        decision: ev.decision,
        persist: ev.persist,
        agentId: ev.agentId,
        taskId: ev.taskId,
      });
      void this.onRawEvent(run, {
        type: 'fastowl_permission_response',
        requestId: ev.requestId,
        decision: ev.decision,
        persist: ev.persist,
        tool_name: ev.toolName,
      });
    };
    permissionService.on('request', onRequest);
    permissionService.on('resolved', onResolved);
    run.detachPermissionListeners = () => {
      permissionService.off('request', onRequest);
      permissionService.off('resolved', onResolved);
    };

    console.log(
      `[agentStructured] resumed run for session ${opts.sessionKey} (task=${opts.taskId ?? 'none'}, transcript=${transcript.length} events)`,
    );
    return run;
  }

  /**
   * Process a single JSON event: stamp `seq`, append to in-memory
   * transcript, broadcast, persist on a schedule.
   */
  private async onRawEvent(
    run: ActiveStructuredRun,
    rawEvent: unknown
  ): Promise<void> {
    if (!rawEvent || typeof rawEvent !== 'object') return;
    const raw = rawEvent as { type?: unknown };
    if (typeof raw.type !== 'string') return;
    const event: AgentEvent = {
      ...(rawEvent as object),
      type: raw.type,
      seq: run.transcript.length,
    } as AgentEvent;

    run.transcript.push(event);
    this.emit('event', run, event);
    // `result` means the current turn finished. For interactive runs
    // the child is now waiting on stdin for the next user message —
    // emit a discrete `turn_complete` so the agent service can flip
    // its status back to idle and re-enable the input box.
    if (event.type === 'result') this.emit('turn_complete', run, event);

    // Capture the CLI's session_id the first time we see one. Stored
    // on `task.metadata.claudeSessionId` so `/tasks/:id/continue` can
    // resume the conversation with `--resume <id>` + a new prompt.
    const eventSessionId = (event as { session_id?: unknown }).session_id;
    if (
      typeof eventSessionId === 'string' &&
      eventSessionId &&
      run.taskId &&
      run.claudeSessionId !== eventSessionId
    ) {
      run.claudeSessionId = eventSessionId;
      this.emit('session_id_captured', run, eventSessionId);
    }

    emitAgentEvent(run.workspaceId, run.agentId, run.taskId, event);
    if (run.taskId) emitTaskEvent(run.workspaceId, run.taskId, event);

    // Persist immediately on key events — result, and any
    // fastowl-synthetic event (permission prompts). Clients
    // reconnecting mid-task need those present so the pending-approval
    // card is visible; waiting for the next 25-event sample isn't
    // acceptable UX. Otherwise sample every N events to cap write
    // churn.
    const eventType = event.type as string;
    const forcePersist =
      eventType === 'result' || eventType.startsWith('fastowl_');
    const shouldPersist = forcePersist || run.transcript.length % TRANSCRIPT_PERSIST_EVERY === 0;
    if (shouldPersist && run.taskId) {
      await this.persistTranscript(run).catch((err) => {
        console.error(`[agentStructured] persist failed for ${run.taskId}:`, err);
      });
    }
  }

  /**
   * Flush the in-memory transcript to `tasks.transcript`. Applies a
   * bounded-size strategy so one unruly task can't fill the jsonb
   * column.
   */
  private async persistTranscript(run: ActiveStructuredRun): Promise<void> {
    if (!run.taskId) return;

    let transcript = run.transcript;
    if (transcript.length > TRANSCRIPT_MAX_EVENTS) {
      const head = transcript.slice(0, 100);
      const tail = transcript.slice(transcript.length - (TRANSCRIPT_MAX_EVENTS - 101));
      const truncationMarker: AgentEvent = {
        seq: -1,
        type: 'system',
        subtype: 'truncated',
        dropped: transcript.length - (head.length + tail.length),
      };
      transcript = [...head, truncationMarker, ...tail];
    }

    await this.db
      .update(tasksTable)
      .set({ transcript: transcript as unknown as object, updatedAt: new Date() })
      .where(eq(tasksTable.id, run.taskId));
  }

  /** Exposed for the dispatcher's force-persist on session close. */
  async flush(sessionKey: string): Promise<void> {
    const run = this.runs.get(sessionKey);
    if (run) await this.persistTranscript(run);
  }
}

/**
 * Build the argv for `claude` given a structured-run request. Kept pure
 * so tests can assert the exact flags without spawning.
 */
export function buildClaudeArgs(opts: StructuredRunOptions): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  // Session persistence left enabled (CLI default) so exited tasks
  // can be resumed with `--resume <id>` + a follow-up prompt. Session
  // files live under `~/.claude/projects/<cwd>/<id>.jsonl`.
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  if (opts.interactive) {
    // Streaming input: stdin carries JSONL user messages, one per
    // turn. We keep the pipe open for `sendMessage` follow-ups.
    args.push('--input-format', 'stream-json');
  }
  if (opts.permissionMode === 'bypass') {
    args.push('--permission-mode', 'bypassPermissions');
  } else if (opts.permissionMode === 'strict') {
    // `default` mode fires PreToolUse hooks on every tool call. The
    // inline settings JSON tells the CLI to invoke our hook script
    // before ANY tool (`matcher: '*'`). The script blocks on a
    // backend HTTP call until the user approves or denies.
    args.push('--permission-mode', 'default');
    if (!opts.hookScriptPath) {
      throw new Error('strict permission mode requires hookScriptPath');
    }
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: opts.hookScriptPath }],
          },
        ],
      },
    };
    args.push('--settings', JSON.stringify(settings));
  }
  // Prompt flows on stdin, not argv — no shell-quoting concerns.
  return args;
}

/**
 * Splits a stream of text into complete JSON objects, one per line.
 * Swallows malformed lines with a console.warn rather than crashing the
 * parse loop — a single bad line shouldn't nuke the run.
 */
export class JsonlLineParser {
  private pending = '';

  push(chunk: string): unknown[] {
    this.pending += chunk;
    const events: unknown[] = [];
    let nl: number;
    while ((nl = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, nl).trim();
      this.pending = this.pending.slice(nl + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        console.warn('[JsonlLineParser] dropping malformed line:', line.slice(0, 200));
      }
    }
    return events;
  }
}

export const agentStructuredService = new AgentStructuredService();
