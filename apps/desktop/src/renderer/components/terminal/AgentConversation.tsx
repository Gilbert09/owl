import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronDown, ChevronRight, Check, X, Shield, Wrench, Brain } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { api } from '../../lib/api';
import type { AgentEvent } from '@fastowl/shared';

interface AgentConversationProps {
  taskId: string;
  transcript: AgentEvent[] | undefined;
  /** When false (completed task replays) permission buttons are hidden. */
  interactive?: boolean;
  /** Display name of the env the task runs on. Surfaced in the auto-allowed indicator. */
  envName?: string;
}

/**
 * Slice 2 renderer for structured-mode tasks. Takes the ordered event
 * stream the backend persists on `tasks.transcript` and lays it out as
 * a conversation: assistant text, collapsible tool calls + results,
 * thinking blocks, and inline permission-request cards.
 *
 * Permission cards are interactive — Approve / Deny / Allow-always
 * buttons POST back to the backend, which unblocks the child CLI's
 * PreToolUse hook. They auto-collapse once the matching
 * `fastowl_permission_response` event arrives on the WebSocket.
 */
export function AgentConversation({
  taskId,
  transcript,
  interactive = true,
  envName,
}: AgentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track "was the user at the bottom before the latest re-render?" so
  // we only auto-scroll on new events when they were following along.
  // Reading scrollHeight/scrollTop inside the effect measures AFTER the
  // new content has landed — by which point the old position is no
  // longer the scroll bottom. Capturing on scroll + ref avoids that.
  const wasAtBottomRef = useRef(true);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Be generous — a ~200px slop handles the permission card adding
    // ~400px of content in a single tick without us ping-ponging.
    wasAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [transcript?.length]);

  const blocks = useMemo(() => buildBlocks(transcript ?? []), [transcript]);

  if (blocks.length === 0) {
    // Task may have events but none render as blocks yet (the very
    // first few events are `system/init`, `rate_limit_event`,
    // `message_start`). Give the user a less-ominous message than
    // "waiting to start" if we've seen any activity at all.
    const hasAnyEvents = (transcript?.length ?? 0) > 0;
    return (
      <div className="h-full flex items-center justify-center text-xs text-zinc-500 bg-[#1a1a1a]">
        {hasAnyEvents
          ? 'Claude is thinking…'
          : 'Waiting for the agent to start…'}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-auto px-4 py-3 text-sm text-zinc-100 bg-[#1a1a1a] space-y-2 min-w-0"
    >
      {blocks.map((block) => (
        <BlockView
          key={block.key}
          block={block}
          taskId={taskId}
          interactive={interactive}
          envName={envName}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block model — the transcript is event-stream shaped; the renderer wants a
// block-stream shape (one "card" per assistant turn, tool call, permission
// prompt, etc.). `buildBlocks` collapses a flat event list into this shape.
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool_use'; key: string; toolId: string; name: string; input: unknown }
  | {
      kind: 'tool_result';
      key: string;
      toolId: string;
      content: unknown;
      isError: boolean;
      /** Filled in at buildBlocks time by pairing with the preceding tool_use. */
      toolName?: string;
      toolInput?: unknown;
    }
  | {
      kind: 'permission';
      key: string;
      requestId: string;
      toolName: string;
      toolInput: unknown;
      status: 'pending' | 'allowed' | 'denied' | 'auto_allowed';
      persist?: boolean;
    }
  | { kind: 'system'; key: string; text: string; subtype?: string }
  | {
      kind: 'result';
      key: string;
      summary: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      isError: boolean;
      denials: number;
    };

function buildBlocks(events: AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  const permissionByRequestId = new Map<string, number>(); // requestId → blocks index
  // Pair tool_result → tool_use by tool_use_id so the collapsed result
  // row can say "Read 40 lines from <file>" instead of dumping bytes.
  const toolUseById = new Map<string, { name: string; input: unknown }>();
  // Live-stream accumulator. The CLI emits `stream_event`s with
  // incremental `content_block_delta`s as Claude writes; the full
  // `assistant` event only lands when the turn is DONE. Until Slice 4c
  // polish we were skipping stream_events entirely, so the terminal
  // stayed blank for several seconds per turn. Now: accumulate the
  // text deltas into a tail block that the user sees grow in real
  // time. When the canonical `assistant` event arrives for the same
  // message id, we reset the accumulator and let the assistant path
  // below render the final content as normal blocks.
  let streamingText = '';
  let streamingMsgId: string | undefined;

  for (const event of events) {
    const seqKey = String(event.seq);

    if (event.type === 'fastowl_permission_request') {
      const reqId = String((event as { requestId?: unknown }).requestId ?? '');
      const idx = blocks.length;
      permissionByRequestId.set(reqId, idx);
      blocks.push({
        kind: 'permission',
        key: `perm-${reqId}`,
        requestId: reqId,
        toolName: String((event as { tool_name?: unknown }).tool_name ?? 'unknown'),
        toolInput: (event as { tool_input?: unknown }).tool_input,
        status: 'pending',
      });
      continue;
    }

    if (event.type === 'fastowl_permission_auto_allowed') {
      const reqId = String((event as { requestId?: unknown }).requestId ?? '');
      blocks.push({
        kind: 'permission',
        key: `perm-${reqId}`,
        requestId: reqId,
        toolName: String((event as { tool_name?: unknown }).tool_name ?? 'unknown'),
        toolInput: (event as { tool_input?: unknown }).tool_input,
        status: 'auto_allowed',
      });
      continue;
    }

    if (event.type === 'fastowl_permission_response') {
      const reqId = String((event as { requestId?: unknown }).requestId ?? '');
      const idx = permissionByRequestId.get(reqId);
      if (idx !== undefined) {
        const existing = blocks[idx];
        if (existing && existing.kind === 'permission') {
          const dec = String((event as { decision?: unknown }).decision ?? 'deny');
          existing.status = dec === 'allow' ? 'allowed' : 'denied';
          existing.persist = Boolean((event as { persist?: unknown }).persist);
        }
      }
      continue;
    }

    if (event.type === 'assistant') {
      // Finalise any in-flight streaming text for this message — the
      // assistant event carries the canonical content, so we should
      // stop appending deltas to the tail block (the assistant path
      // below pushes proper text/tool_use/thinking blocks instead).
      const msgId = (event.message as { id?: string } | undefined)?.id;
      if (msgId && msgId === streamingMsgId) {
        streamingText = '';
        streamingMsgId = undefined;
      }
      const content = (event.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (let i = 0; i < content.length; i++) {
        const b = content[i] as {
          type?: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          input?: unknown;
        };
        if (b.type === 'text' && b.text) {
          blocks.push({ kind: 'text', key: `${seqKey}.${i}`, text: b.text });
        } else if (b.type === 'thinking' && b.thinking) {
          blocks.push({ kind: 'thinking', key: `${seqKey}.${i}`, text: b.thinking });
        } else if (b.type === 'tool_use') {
          const id = String(b.id ?? '');
          const name = String(b.name ?? 'unknown');
          const inp = b.input ?? {};
          if (id) toolUseById.set(id, { name, input: inp });
          blocks.push({
            kind: 'tool_use',
            key: `${seqKey}.${i}`,
            toolId: id,
            name,
            input: inp,
          });
        }
      }
      continue;
    }

    if (event.type === 'user') {
      const content = (event.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (let i = 0; i < content.length; i++) {
        const b = content[i] as {
          type?: string;
          content?: unknown;
          tool_use_id?: string;
          is_error?: boolean;
        };
        if (b.type === 'tool_result') {
          const toolId = String(b.tool_use_id ?? '');
          const paired = toolId ? toolUseById.get(toolId) : undefined;
          blocks.push({
            kind: 'tool_result',
            key: `${seqKey}.${i}`,
            toolId,
            content: b.content ?? '',
            isError: Boolean(b.is_error),
            toolName: paired?.name,
            toolInput: paired?.input,
          });
        }
      }
      continue;
    }

    if (event.type === 'result') {
      const usage = (event.usage as { input_tokens?: number; output_tokens?: number }) ?? {};
      blocks.push({
        kind: 'result',
        key: seqKey,
        summary: String(event.result ?? ''),
        costUsd: event.total_cost_usd,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        isError: Boolean(event.is_error),
        denials: event.permission_denials?.length ?? 0,
      });
      continue;
    }

    // System events we actually want to show: stderr, spawn_error, and
    // the truncation marker. Drop init / status / etc — they're noise
    // in a conversation view.
    if (event.type === 'system') {
      const show = ['stderr', 'spawn_error', 'truncated'].includes(String(event.subtype ?? ''));
      if (show) {
        blocks.push({
          kind: 'system',
          key: seqKey,
          text: String((event as { text?: unknown }).text ?? event.subtype ?? ''),
          subtype: event.subtype,
        });
      }
      continue;
    }

    if (event.type === 'stream_event') {
      const inner = event.event as
        | {
            type?: string;
            message?: { id?: string };
            delta?: { type?: string; text?: string };
          }
        | undefined;
      if (!inner) continue;
      if (inner.type === 'message_start' && inner.message?.id) {
        // New turn starting — reset the accumulator. The message id
        // lets us match this streaming session to its forthcoming
        // `assistant` event.
        streamingMsgId = inner.message.id;
        streamingText = '';
        continue;
      }
      if (
        inner.type === 'content_block_delta' &&
        inner.delta?.type === 'text_delta' &&
        typeof inner.delta.text === 'string'
      ) {
        streamingText += inner.delta.text;
        continue;
      }
      continue;
    }

    // `rate_limit_event` and anything else unrecognised: suppressed.
  }

  // If the latest turn is still in-flight (assistant event hasn't
  // landed yet), show the accumulated streaming text as a tail block
  // so the user sees the response building in real time.
  if (streamingText) {
    blocks.push({
      kind: 'text',
      key: `stream-${streamingMsgId ?? 'live'}`,
      text: streamingText,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Block views
// ---------------------------------------------------------------------------

function BlockView({
  block,
  taskId,
  interactive,
  envName,
}: {
  block: Block;
  taskId: string;
  interactive: boolean;
  envName?: string;
}) {
  switch (block.kind) {
    case 'text':
      return <TextBlock text={block.text} />;
    case 'thinking':
      return <ThinkingBlock text={block.text} />;
    case 'tool_use':
      return <ToolUseBlock name={block.name} input={block.input} />;
    case 'tool_result':
      return (
        <ToolResultBlock
          content={block.content}
          isError={block.isError}
          toolName={block.toolName}
          toolInput={block.toolInput}
        />
      );
    case 'permission':
      return (
        <PermissionBlock
          taskId={taskId}
          requestId={block.requestId}
          toolName={block.toolName}
          toolInput={block.toolInput}
          status={block.status}
          persist={block.persist}
          interactive={interactive}
          envName={envName}
        />
      );
    case 'system':
      return <SystemBlock text={block.text} subtype={block.subtype} />;
    case 'result':
      return (
        <ResultBlock
          summary={block.summary}
          costUsd={block.costUsd}
          inputTokens={block.inputTokens}
          outputTokens={block.outputTokens}
          isError={block.isError}
          denials={block.denials}
        />
      );
  }
}

function TextBlock({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap leading-relaxed min-w-0 [overflow-wrap:anywhere]">
      {renderMarkdownish(text)}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      icon={<Brain className="w-3.5 h-3.5 text-purple-300" />}
      title="Thinking"
      dim
    >
      <div className="whitespace-pre-wrap text-xs text-zinc-400 leading-relaxed">{text}</div>
    </Collapsible>
  );
}

function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  const summary = summariseToolUse(name, input);
  return (
    <Collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      icon={<Wrench className="w-3.5 h-3.5 text-blue-300" />}
      title={
        <span className="block [overflow-wrap:anywhere]">
          <span className="text-blue-300">{name}</span>
          {summary && (
            <span className="ml-2 text-zinc-400 font-normal font-mono">
              {summary}
            </span>
          )}
        </span>
      }
    >
      <PrettyJson value={input} />
    </Collapsible>
  );
}

function ToolResultBlock({
  content,
  isError,
  toolName,
  toolInput,
}: {
  content: unknown;
  isError: boolean;
  toolName?: string;
  toolInput?: unknown;
}) {
  const [open, setOpen] = useState(false);
  const extracted = extractTextContent(content);
  const text = extracted ?? JSON.stringify(content, null, 2);
  const lineCount = text ? text.split('\n').length : 0;

  // Result-aware collapsed row. For known tools we can say *what*
  // landed ("Read N lines from <file>") instead of dumping the first
  // line of output as a mystery preview.
  const title = ((): React.ReactNode => {
    if (isError) {
      const preview = text.split('\n')[0]?.slice(0, 160) || 'error';
      return <span className="text-red-300 font-normal">{preview}</span>;
    }
    if (toolName === 'Read' && toolInput && typeof toolInput === 'object') {
      const p = (toolInput as { file_path?: unknown }).file_path;
      if (typeof p === 'string') {
        return (
          <span className="font-normal text-zinc-300">
            Read {lineCount} lines from{' '}
            <span className="font-mono text-zinc-200">{shortenPath(p)}</span>
          </span>
        );
      }
    }
    if (toolName === 'Grep' && toolInput && typeof toolInput === 'object') {
      const matches = text.match(/^Found (\d+)/)?.[1];
      if (matches) {
        return (
          <span className="font-normal text-zinc-300">
            Grep · {matches} matches
          </span>
        );
      }
    }
    if (toolName === 'Glob') {
      return (
        <span className="font-normal text-zinc-300">
          Glob · {lineCount} {lineCount === 1 ? 'path' : 'paths'}
        </span>
      );
    }
    if (toolName === 'Bash') {
      const preview = text.split('\n')[0]?.slice(0, 160) ?? '';
      return (
        <span className="font-normal text-zinc-300 font-mono">
          {preview || `${lineCount} lines`}
        </span>
      );
    }
    const preview = text.split('\n')[0]?.slice(0, 160) || 'ok';
    return <span className="font-normal">{preview}</span>;
  })();

  return (
    <Collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      icon={
        isError ? (
          <X className="w-3.5 h-3.5 text-red-400" />
        ) : (
          <Check className="w-3.5 h-3.5 text-green-400" />
        )
      }
      title={
        <span className={cn('block [overflow-wrap:anywhere]', isError && 'text-red-300')}>
          {title}
        </span>
      }
      dim
    >
      <pre className="text-xs font-mono whitespace-pre-wrap [overflow-wrap:anywhere] text-zinc-200 bg-black/30 rounded p-2 overflow-x-auto">
        {text}
      </pre>
    </Collapsible>
  );
}

function PermissionBlock({
  taskId,
  requestId,
  toolName,
  toolInput,
  status,
  persist,
  interactive,
  envName,
}: {
  taskId: string;
  requestId: string;
  toolName: string;
  toolInput: unknown;
  status: 'pending' | 'allowed' | 'denied' | 'auto_allowed';
  persist?: boolean;
  interactive: boolean;
  envName?: string;
}) {
  const [busy, setBusy] = useState<null | 'allow' | 'deny' | 'allow-always'>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (decision: 'allow' | 'deny', persistDecision: boolean) => {
    const btn = decision === 'deny' ? 'deny' : persistDecision ? 'allow-always' : 'allow';
    setBusy(btn);
    setError(null);
    try {
      await api.tasks.respondToPermission(taskId, requestId, decision, persistDecision);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to respond');
    } finally {
      setBusy(null);
    }
  };

  if (status === 'auto_allowed') {
    // One-line summary up top; click to expand the full tool input
    // so the user can audit what ran under the standing approval.
    return (
      <AutoAllowedPermission
        toolName={toolName}
        toolInput={toolInput}
        envName={envName}
      />
    );
  }

  const resolved = status !== 'pending';
  return (
    <div
      className={cn(
        'rounded border px-3 py-2.5 text-sm',
        resolved
          ? status === 'allowed'
            ? 'border-green-500/30 bg-green-500/5'
            : 'border-red-500/30 bg-red-500/5'
          : 'border-yellow-500/40 bg-yellow-500/10'
      )}
    >
      <div className="flex items-center gap-2 text-xs mb-2">
        <Shield
          className={cn(
            'w-4 h-4',
            resolved
              ? status === 'allowed'
                ? 'text-green-400'
                : 'text-red-400'
              : 'text-yellow-400'
          )}
        />
        <span className="font-semibold">
          {resolved
            ? status === 'allowed'
              ? persist
                ? `Allowed ${toolName} (always for this env)`
                : `Allowed ${toolName}`
              : `Denied ${toolName}`
            : `Approve ${toolName}?`}
        </span>
      </div>
      <ToolInputPreview toolName={toolName} toolInput={toolInput} />
      {!resolved && interactive && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => respond('allow', false)}
            disabled={busy !== null}
          >
            {busy === 'allow' ? '…' : 'Allow once'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => respond('allow', true)}
            disabled={busy !== null}
            title="Pre-approve this tool on this environment — no more prompts"
          >
            {busy === 'allow-always' ? '…' : `Allow always (${toolName})`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-400 hover:text-red-300"
            onClick={() => respond('deny', false)}
            disabled={busy !== null}
          >
            {busy === 'deny' ? '…' : 'Deny'}
          </Button>
          {error && <span className="text-xs text-red-400 self-center">{error}</span>}
        </div>
      )}
    </div>
  );
}

function SystemBlock({ text, subtype }: { text: string; subtype?: string }) {
  return (
    <div className="text-xs text-zinc-400 italic border-l-2 border-zinc-700 pl-2">
      {subtype ? <span className="uppercase tracking-wide mr-1">{subtype}</span> : null}
      {text}
    </div>
  );
}

function ResultBlock({
  costUsd,
  inputTokens,
  outputTokens,
  isError,
  denials,
}: {
  summary: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  isError: boolean;
  denials: number;
}) {
  // Intentionally no echo of the final assistant text here — it's
  // already the last block above this footer, rendered in full.
  // Repeating it as a truncated one-liner next to the cost/tokens
  // was noisy.
  return (
    <div
      className={cn(
        'mt-3 pt-2 border-t text-xs flex items-center gap-3',
        isError ? 'border-red-500/30 text-red-300' : 'border-zinc-800 text-zinc-400'
      )}
    >
      <span className={isError ? 'font-medium' : ''}>
        {isError ? 'Ended with error' : 'Run complete'}
      </span>
      {typeof costUsd === 'number' && <span>${costUsd.toFixed(4)}</span>}
      {(inputTokens ?? outputTokens) !== undefined && (
        <span>
          {inputTokens ?? 0}→{outputTokens ?? 0} tok
        </span>
      )}
      {denials > 0 && (
        <span className="text-yellow-400">
          {denials} permission den{denials === 1 ? 'ial' : 'ials'}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------------

function Collapsible({
  open,
  onToggle,
  icon,
  title,
  children,
  dim,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  title: React.ReactNode;
  children: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div className={cn('rounded border border-white/5 overflow-hidden', dim && 'bg-black/20')}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-white/5 rounded-t"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 flex-none text-zinc-400 mt-0.5" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-none text-zinc-400 mt-0.5" />
        )}
        <span className="flex-none mt-0.5">{icon}</span>
        <span className="font-medium min-w-0 flex-1 break-words">
          {title}
        </span>
      </button>
      {open && <div className="px-2.5 pb-2.5">{children}</div>}
    </div>
  );
}

/**
 * Collapsed-by-default auto-allowed row: shows tool name + env, click
 * the chevron to see the same tool-aware input preview as an
 * interactive permission card. Keeps the transcript honest about
 * what actually ran without drowning the view in green rows.
 */
function AutoAllowedPermission({
  toolName,
  toolInput,
  envName,
}: {
  toolName: string;
  toolInput: unknown;
  envName?: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = summariseToolUse(toolName, toolInput);
  return (
    <div className="rounded border border-green-500/20 bg-green-500/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 text-xs text-left hover:bg-green-500/10"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 flex-none text-green-300 mt-0.5" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-none text-green-300 mt-0.5" />
        )}
        <Shield className="w-3.5 h-3.5 flex-none text-green-400 mt-0.5" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-green-300">
          <span className="font-medium">{toolName}</span>
          {summary && (
            <span className="ml-2 text-green-200/80 font-mono font-normal">
              {summary}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <div className="text-[11px] text-green-200/60 italic">
            Auto-allowed — pre-approved for {envName ?? 'this environment'}.
          </div>
          <ToolInputPreview toolName={toolName} toolInput={toolInput} />
        </div>
      )}
    </div>
  );
}

/**
 * Tool-aware preview for permission cards. Raw JSON is unreadable for
 * common tools (Grep, Bash, Edit, ...) — instead surface the fields
 * that matter for an approval decision. User can still drill into the
 * full JSON via the "Show full input" toggle.
 *
 * Unknown tools fall back to the JSON dump so this is never worse
 * than the previous default.
 */
function ToolInputPreview({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: unknown;
}) {
  const [showJson, setShowJson] = useState(false);
  const summary = renderToolInputSummary(toolName, toolInput);

  return (
    <div className="space-y-2">
      {summary ?? <PrettyJson value={toolInput} />}
      {summary && (
        <button
          type="button"
          onClick={() => setShowJson((v) => !v)}
          className="text-[11px] text-zinc-400 hover:text-zinc-200 underline-offset-2 hover:underline"
        >
          {showJson ? 'Hide full input' : 'Show full input'}
        </button>
      )}
      {summary && showJson && <PrettyJson value={toolInput} />}
    </div>
  );
}

function renderToolInputSummary(
  toolName: string,
  toolInput: unknown
): React.ReactNode | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;

  const field = (
    label: string,
    value: unknown,
    opts: { mono?: boolean; block?: boolean } = {}
  ) => {
    if (value === undefined || value === null || value === '') return null;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return (
      <div
        key={label}
        className={cn(
          'flex gap-2',
          opts.block ? 'flex-col' : 'items-baseline'
        )}
      >
        <span className="text-[11px] uppercase tracking-wide text-zinc-500 shrink-0">
          {label}
        </span>
        <span
          className={cn(
            'text-zinc-100 break-all',
            opts.mono && 'font-mono text-xs'
          )}
        >
          {text}
        </span>
      </div>
    );
  };

  const wrap = (children: React.ReactNode) => (
    <div className="bg-black/30 rounded p-2 space-y-1">{children}</div>
  );

  switch (toolName) {
    case 'Bash':
      return wrap(
        <>
          {field('command', input.command, { mono: true, block: true })}
          {field('description', input.description)}
          {typeof input.timeout === 'number' && field('timeout', `${input.timeout}ms`)}
        </>
      );
    case 'Read':
      return wrap(
        <>
          {field('file', input.file_path, { mono: true })}
          {input.offset !== undefined && field('offset', input.offset)}
          {input.limit !== undefined && field('limit', input.limit)}
        </>
      );
    case 'Edit':
    case 'Write':
      return wrap(
        <>
          {field('file', input.file_path, { mono: true })}
          {typeof input.old_string === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">
                replace
              </div>
              <pre className="font-mono text-xs bg-red-500/10 text-red-200 rounded px-2 py-1 whitespace-pre-wrap break-all">
                {truncate(input.old_string as string, 400)}
              </pre>
            </div>
          )}
          {typeof input.new_string === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">
                with
              </div>
              <pre className="font-mono text-xs bg-green-500/10 text-green-200 rounded px-2 py-1 whitespace-pre-wrap break-all">
                {truncate(input.new_string as string, 400)}
              </pre>
            </div>
          )}
          {toolName === 'Write' && typeof input.content === 'string' && (
            <pre className="font-mono text-xs bg-green-500/10 text-green-200 rounded px-2 py-1 whitespace-pre-wrap break-all">
              {truncate(input.content as string, 400)}
            </pre>
          )}
        </>
      );
    case 'Grep':
      return wrap(
        <>
          {field('pattern', input.pattern, { mono: true })}
          {field('path', input.path, { mono: true })}
          {field('glob', input.glob, { mono: true })}
          {field('type', input.type)}
          {field('output', input.output_mode)}
        </>
      );
    case 'Glob':
      return wrap(
        <>
          {field('pattern', input.pattern, { mono: true })}
          {field('path', input.path, { mono: true })}
        </>
      );
    case 'WebFetch':
    case 'WebSearch':
      return wrap(
        <>
          {field('url', input.url, { mono: true })}
          {field('query', input.query)}
          {field('prompt', input.prompt)}
        </>
      );
    case 'Task':
    case 'Agent':
      return wrap(
        <>
          {field('description', input.description)}
          {field('subagent', input.subagent_type)}
          {typeof input.prompt === 'string' && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">
                prompt
              </div>
              <pre className="font-mono text-xs whitespace-pre-wrap break-all text-zinc-200">
                {truncate(input.prompt as string, 600)}
              </pre>
            </div>
          )}
        </>
      );
    default:
      return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [${text.length - max} more chars]`;
}

function PrettyJson({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap text-zinc-200 bg-black/30 rounded p-2 overflow-x-auto">
      {text}
    </pre>
  );
}

/**
 * Light-weight "markdownish" renderer — preserves newlines, handles
 * fenced code blocks and inline backticks. No link parsing, no bold /
 * italic — deliberately narrow to avoid a markdown dep. Claude's
 * output in code contexts is mostly paragraphs + fenced code anyway.
 */
function renderMarkdownish(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let paragraphBuf: string[] = [];
  const flush = () => {
    if (paragraphBuf.length === 0) return;
    const para = paragraphBuf.join('\n');
    paragraphBuf = [];
    parts.push(
      <p
        key={`p-${parts.length}`}
        className="whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {renderInlineCode(para)}
      </p>
    );
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip closing fence (if present).
      if (i < lines.length) i++;
      parts.push(
        <pre
          key={`c-${parts.length}`}
          className="text-xs font-mono whitespace-pre-wrap [overflow-wrap:anywhere] bg-black/40 rounded p-2 overflow-x-auto my-1 max-w-full"
        >
          {lang && (
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
              {lang}
            </div>
          )}
          {codeLines.join('\n')}
        </pre>
      );
      continue;
    }
    paragraphBuf.push(line);
    i++;
  }
  flush();
  return parts;
}

function renderInlineCode(text: string): React.ReactNode {
  // Split on backtick spans. Odd indices are code, even are plain.
  const pieces = text.split(/(`[^`]+`)/g);
  return pieces.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length >= 2) {
      return (
        <code
          key={i}
          className="font-mono text-xs bg-white/10 rounded px-1 [overflow-wrap:anywhere]"
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

/**
 * Tool-aware one-liner for the collapsed tool_use / auto-allowed row.
 * Goal: answer "what did Claude just do?" at a glance without forcing
 * a click. Unknown tools fall back to the old generic arg dump.
 */
function summariseToolUse(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;

  const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  switch (toolName) {
    case 'Read': {
      const p = asString(i.file_path);
      if (!p) break;
      return shortenPath(p);
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const p = asString(i.file_path);
      if (!p) break;
      return shortenPath(p);
    }
    case 'Bash': {
      const cmd = asString(i.command);
      if (!cmd) break;
      return truncateInline(cmd, 120);
    }
    case 'Grep': {
      const pattern = asString(i.pattern);
      const path = asString(i.path);
      if (!pattern) break;
      return path ? `${pattern}  in  ${shortenPath(path)}` : pattern;
    }
    case 'Glob': {
      const pattern = asString(i.pattern);
      const path = asString(i.path);
      if (!pattern) break;
      return path ? `${pattern}  in  ${shortenPath(path)}` : pattern;
    }
    case 'WebFetch': {
      return asString(i.url) ?? '';
    }
    case 'WebSearch': {
      return asString(i.query) ?? '';
    }
    case 'Task':
    case 'Agent': {
      return asString(i.description) ?? '';
    }
    case 'TodoWrite':
      return '';
  }

  return summariseArgs(input);
}

/**
 * Strip the absolute prefix off a path so the user sees the
 * repo-relative bit. We don't know the repo root from the renderer,
 * so we slice from the first monorepo-looking segment (packages/apps/
 * src) and otherwise tilde the user's home. Not perfect, but kills
 * the noisy /Users/<me>/dev/<org>/<repo>/ prefix 99% of the time.
 */
function shortenPath(p: string): string {
  for (const marker of ['/packages/', '/apps/']) {
    const idx = p.indexOf(marker);
    if (idx !== -1) return p.slice(idx + 1);
  }
  const srcIdx = p.indexOf('/src/');
  if (srcIdx !== -1) {
    // Include the dir before /src/ for context (often the repo name).
    const before = p.lastIndexOf('/', srcIdx - 1);
    if (before !== -1) return p.slice(before + 1);
  }
  if (p.startsWith('/Users/') || p.startsWith('/home/')) {
    const after = p.indexOf('/', p.indexOf('/', 1) + 1);
    if (after !== -1) return '~' + p.slice(after);
  }
  return p;
}

function truncateInline(s: string, max: number): string {
  const single = s.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : single.slice(0, max - 1) + '…';
}

function summariseArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 2);
  return entries
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${(s ?? '').toString().slice(0, 48)}`;
    })
    .join(', ');
}

/**
 * Unwrap a `[{type: 'text', text: '…'}]`-shaped content array into a
 * plain string. Anthropic's message content is always that shape when
 * a subagent (Task/Agent tool) returns its answer — today we JSON.stringify
 * the whole array, which makes the transcript unreadable. If the array
 * is heterogeneous (has non-text items) we bail and let the caller
 * dump raw JSON as a safe fallback.
 */
function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string'
    ) {
      texts.push((item as { text: string }).text);
    } else {
      return null;
    }
  }
  return texts.join('\n\n');
}
