import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { eq } from 'drizzle-orm';
import type { AgentEvent } from '@fastowl/shared';
import { getDbClient, type Database } from '../db/client.js';
import { tasks as tasksTable } from '../db/schema.js';
import { emitAgentEvent, emitTaskEvent } from './websocket.js';
import { permissionService, type PendingRequest } from './permissionService.js';
import { emitAgentPermissionRequest, emitAgentPermissionResponse } from './websocket.js';

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
  workspaceId: string;
  taskId?: string;
  cwd?: string;
  prompt: string;
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
  /** Forward these env vars to the child. */
  env?: Record<string, string>;
  /** Allow callers to override the binary (tests). */
  claudeBinary?: string;
}

export interface ActiveStructuredRun {
  sessionKey: string;
  agentId: string;
  taskId?: string;
  workspaceId: string;
  /** Bytes-since-last-persist; drives the sampled DB writes. */
  transcript: AgentEvent[];
  child: ChildProcess;
  startedAt: Date;
  /** Resolves with the final exit code once the process exits. */
  completion: Promise<number>;
  /** Per-run token presented by the child's PreToolUse hook. */
  permissionToken?: string;
  /** Cleanup for permissionService listeners scoped to this run. */
  detachPermissionListeners?: () => void;
}

/**
 * Drives the `claude -p --output-format stream-json --verbose` pipeline.
 * Parses JSONL events off stdout, broadcasts them as structured WS
 * messages, and persists a bounded transcript on `tasks.transcript`.
 *
 * Co-exists with the PTY-based `agentService`: one dispatches to the
 * other based on `environment.renderer`.
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
    run.child.kill('SIGTERM');
  }

  /**
   * Spawn a non-PTY `claude -p …` with stream-json output and wire
   * stdout → JSONL parser → event emitter. Returns once the child is
   * live; callers can await `activeRun.completion` for the exit code.
   */
  start(opts: StructuredRunOptions): ActiveStructuredRun {
    if (this.runs.has(opts.sessionKey)) {
      throw new Error(`structured run already active for ${opts.sessionKey}`);
    }

    const args = buildClaudeArgs(opts);
    const binary = opts.claudeBinary ?? 'claude';

    // For strict mode, mint a per-run permission token so the child's
    // hook can authenticate itself back to the backend without a user
    // JWT. Token is in-process-only; never touches disk.
    let permissionToken: string | undefined;
    const childEnv = { ...process.env, ...(opts.env ?? {}) };
    if (opts.permissionMode === 'strict') {
      permissionToken = permissionService.registerRun({
        agentId: opts.agentId,
        environmentId: (opts.env?.FASTOWL_ENVIRONMENT_ID as string) ?? '',
        workspaceId: opts.workspaceId,
        taskId: opts.taskId,
      });
      childEnv.FASTOWL_PERMISSION_TOKEN = permissionToken;
      childEnv.FASTOWL_AGENT_ID = opts.agentId;
    }

    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Prompt arrives on stdin so shell-quoting can't mangle it.
    if (child.stdin) {
      child.stdin.write(opts.prompt);
      child.stdin.end();
    }

    const run: ActiveStructuredRun = {
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
      taskId: opts.taskId,
      workspaceId: opts.workspaceId,
      transcript: [],
      child,
      startedAt: new Date(),
      permissionToken,
      completion: new Promise<number>((resolve) => {
        child.on('exit', (code) => resolve(code ?? 0));
      }),
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

    const parser = new JsonlLineParser();
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const rawEvent of parser.push(chunk.toString('utf-8'))) {
        this.onRawEvent(run, rawEvent).catch((err) => {
          console.error(`[agentStructured ${run.sessionKey}] onRawEvent failed:`, err);
        });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // stderr usually means the CLI itself misbehaved (not the LLM).
      // Surface it as a synthetic stderr event so the UI can show it.
      const text = chunk.toString('utf-8');
      void this.onRawEvent(run, {
        type: 'system',
        subtype: 'stderr',
        text,
      });
    });
    child.on('error', (err) => {
      void this.onRawEvent(run, {
        type: 'system',
        subtype: 'spawn_error',
        text: err.message,
      });
    });
    child.on('exit', (code) => {
      // Drain any trailing partial — if the CLI exited mid-line we
      // drop that fragment rather than fabricate an event.
      this.runs.delete(opts.sessionKey);
      run.detachPermissionListeners?.();
      if (permissionToken) permissionService.unregisterRun(permissionToken);
      this.emit('exit', run, code ?? 0);
    });

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
    '--no-session-persistence',
  ];
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
