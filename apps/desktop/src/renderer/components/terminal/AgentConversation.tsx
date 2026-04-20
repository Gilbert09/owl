import React, { useEffect, useMemo, useRef, useState } from 'react';
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
}: AgentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [transcript?.length]);

  const blocks = useMemo(() => buildBlocks(transcript ?? []), [transcript]);

  if (blocks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-zinc-500 bg-[#1a1a1a]">
        Waiting for the agent to start…
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-auto px-4 py-3 text-sm text-zinc-100 bg-[#1a1a1a] space-y-2"
    >
      {blocks.map((block) => (
        <BlockView key={block.key} block={block} taskId={taskId} interactive={interactive} />
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
  | { kind: 'tool_result'; key: string; toolId: string; content: unknown; isError: boolean }
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
          blocks.push({
            kind: 'tool_use',
            key: `${seqKey}.${i}`,
            toolId: String(b.id ?? ''),
            name: String(b.name ?? 'unknown'),
            input: b.input ?? {},
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
          blocks.push({
            kind: 'tool_result',
            key: `${seqKey}.${i}`,
            toolId: String(b.tool_use_id ?? ''),
            content: b.content ?? '',
            isError: Boolean(b.is_error),
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

    // `stream_event`, `rate_limit_event`, and anything else the CLI
    // emits are suppressed — they flow through for debugging but the
    // conversation view doesn't need them.
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
}: {
  block: Block;
  taskId: string;
  interactive: boolean;
}) {
  switch (block.kind) {
    case 'text':
      return <TextBlock text={block.text} />;
    case 'thinking':
      return <ThinkingBlock text={block.text} />;
    case 'tool_use':
      return <ToolUseBlock name={block.name} input={block.input} />;
    case 'tool_result':
      return <ToolResultBlock content={block.content} isError={block.isError} />;
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
  return <div className="whitespace-pre-wrap leading-relaxed">{renderMarkdownish(text)}</div>;
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
  return (
    <Collapsible
      open={open}
      onToggle={() => setOpen((v) => !v)}
      icon={<Wrench className="w-3.5 h-3.5 text-blue-300" />}
      title={
        <span>
          <span className="text-blue-300">{name}</span>
          <span className="ml-2 text-zinc-400 font-normal">
            {summariseArgs(input)}
          </span>
        </span>
      }
    >
      <PrettyJson value={input} />
    </Collapsible>
  );
}

function ToolResultBlock({ content, isError }: { content: unknown; isError: boolean }) {
  const [open, setOpen] = useState(false);
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const preview = text.split('\n').slice(0, 1).join('').slice(0, 160);
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
        <span className={cn('font-normal', isError && 'text-red-300')}>
          {preview || (isError ? 'error' : 'ok')}
        </span>
      }
      dim
    >
      <pre className="text-xs font-mono whitespace-pre-wrap text-zinc-200 bg-black/30 rounded p-2 overflow-x-auto">
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
}: {
  taskId: string;
  requestId: string;
  toolName: string;
  toolInput: unknown;
  status: 'pending' | 'allowed' | 'denied' | 'auto_allowed';
  persist?: boolean;
  interactive: boolean;
}) {
  const [busy, setBusy] = useState<null | 'allow' | 'deny' | 'allow-always'>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (decision: 'allow' | 'deny', persist: boolean) => {
    const btn = decision === 'deny' ? 'deny' : persist ? 'allow-always' : 'allow';
    setBusy(btn);
    setError(null);
    try {
      await api.tasks.respondToPermission(taskId, requestId, decision, persist);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to respond');
    } finally {
      setBusy(null);
    }
  };

  if (status === 'auto_allowed') {
    return (
      <div className="rounded border border-green-500/20 bg-green-500/5 px-3 py-2 text-xs text-green-300 flex items-center gap-2">
        <Shield className="w-3.5 h-3.5" />
        <span className="font-medium">{toolName}</span>
        <span className="text-green-200/60">auto-allowed (pre-approved for this env)</span>
      </div>
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
      <PrettyJson value={toolInput} />
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
  summary,
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
      {typeof costUsd === 'number' && (
        <span>${costUsd.toFixed(4)}</span>
      )}
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
      {summary && <span className="italic truncate">{summary}</span>}
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
    <div className={cn('rounded border border-white/5', dim && 'bg-black/20')}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-white/5 rounded-t"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 flex-none text-zinc-400" />
        ) : (
          <ChevronRight className="w-3 h-3 flex-none text-zinc-400" />
        )}
        {icon}
        <span className="font-medium">{title}</span>
      </button>
      {open && <div className="px-2.5 pb-2.5">{children}</div>}
    </div>
  );
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
      <p key={`p-${parts.length}`} className="whitespace-pre-wrap">
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
          className="text-xs font-mono whitespace-pre-wrap bg-black/40 rounded p-2 overflow-x-auto my-1"
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
        <code key={i} className="font-mono text-xs bg-white/10 rounded px-1">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
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
