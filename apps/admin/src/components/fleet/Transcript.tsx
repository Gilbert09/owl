import { useMemo, useState } from 'react';
import type { AdminRunEvent, AgentEvent, Block } from '@talyn/shared';
import { buildBlocks } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { absolute } from '../../lib/format';

/**
 * A run's transcript, readable.
 *
 * The console used to render one row per raw frame: seq, time, type, and
 * whatever string field `summarise` could find first. For the SDK's own events
 * that field is usually nothing — the content lives in `message.content[]` — so
 * an entire agent run read as a column of the word "assistant" and you had to
 * expand every row to learn anything.
 *
 * So it renders BLOCKS, the same model apps/web and apps/desktop use
 * (`buildBlocks` in @talyn/shared): assistant prose, a tool call with its
 * arguments, that call's result paired back to it, and the closing result card.
 *
 * TEXT, NEVER MARKUP. apps/web renders the same blocks through
 * `renderMarkdownish`; this console must not. It shows cross-tenant transcripts,
 * and an HTML-rendering path it does not need would undo one of the two
 * mitigations apps/web relies on for its localStorage session (see
 * apps/admin/README.md). React escapes text children, and everything below is a
 * text child.
 *
 * Every block keeps a way back to the frames it came from — `buildBlocks` keys
 * blocks by their source `seq` — because a readable view that cannot be checked
 * against the wire is a view you cannot debug a protocol with.
 */

export type TranscriptMode = 'readable' | 'raw';

export function Transcript({
  events,
  mode,
}: {
  events: AdminRunEvent[];
  mode: TranscriptMode;
}) {
  // buildBlocks wants the agent events; the fleet wraps each one with seq/at.
  // Carry seq INTO the event so block keys point back at a real frame.
  const agentEvents = useMemo<AgentEvent[]>(
    () =>
      events.map((e) => ({
        ...(e.event as Record<string, unknown>),
        seq: e.seq,
      })) as AgentEvent[],
    [events]
  );

  const bySeq = useMemo(() => {
    const m = new Map<number, AdminRunEvent>();
    for (const e of events) m.set(e.seq, e);
    return m;
  }, [events]);

  const blocks = useMemo(() => buildBlocks(agentEvents), [agentEvents]);

  if (mode === 'raw') {
    return (
      <div className="divide-y divide-border/60">
        {events.map((event) => (
          <RawRow key={event.seq} event={event} />
        ))}
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/60">
      {blocks.map((block) => (
        <BlockRow key={block.key} block={block} source={sourceFor(block, bySeq)} />
      ))}
    </div>
  );
}

/**
 * The frame a block came from, for its raw view.
 *
 * Block keys are `<seq>` or `<seq>.<index>`; the permission and streaming kinds
 * use their own prefixes and have no single source frame, which is why this
 * returns null rather than guessing.
 */
function sourceFor(block: Block, bySeq: Map<number, AdminRunEvent>): AdminRunEvent | null {
  const head = block.key.split('.')[0] ?? '';
  const seq = Number(head);
  if (!Number.isFinite(seq)) return null;
  return bySeq.get(seq) ?? null;
}

function BlockRow({ block, source }: { block: Block; source: AdminRunEvent | null }) {
  const [showRaw, setShowRaw] = useState(false);
  const meta = describe(block);

  return (
    <div className="px-3 py-2 hover:bg-accent/20">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide',
            meta.tone
          )}
        >
          {meta.label}
        </span>
        {meta.title && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{meta.title}</span>
        )}
        {!meta.title && <span className="flex-1" />}
        {source && (
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-foreground"
            title={`Frame ${source.seq} · ${absolute(source.at)}`}
          >
            {showRaw ? 'hide raw' : `raw #${source.seq}`}
          </button>
        )}
      </div>

      {meta.body && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">
          {meta.body}
        </pre>
      )}

      {showRaw && source && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
          {JSON.stringify(source.event, null, 2)}
        </pre>
      )}
    </div>
  );
}

function RawRow({ event }: { event: AdminRunEvent }) {
  const [open, setOpen] = useState(false);
  const type = typeof event.event?.type === 'string' ? (event.event.type as string) : 'event';
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-accent/40"
      >
        <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {event.seq}
        </span>
        <span
          className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground"
          title={absolute(event.at)}
        >
          {new Date(event.at).toLocaleTimeString()}
        </span>
        <span className="w-28 shrink-0 truncate text-xs font-medium">{type}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(event.event).slice(0, 200)}
        </span>
      </button>
      {open && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border/60 bg-muted/40 px-3 py-2 font-mono text-[11px]">
          {JSON.stringify(event.event, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** How one block presents: a label, an optional one-line title, a body. */
interface Described {
  label: string;
  tone: string;
  title?: string;
  body?: string;
}

const TONE = {
  assistant: 'bg-primary/10 text-primary',
  thinking: 'bg-muted text-muted-foreground',
  tool: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  result: 'bg-muted text-muted-foreground',
  error: 'bg-destructive/10 text-destructive',
  system: 'bg-muted text-muted-foreground',
} as const;

function describe(block: Block): Described {
  switch (block.kind) {
    case 'text':
      return { label: 'agent', tone: TONE.assistant, body: block.text };
    case 'thinking':
      return { label: 'thinking', tone: TONE.thinking, body: block.text };
    case 'tool_use':
      return {
        label: 'tool',
        tone: TONE.tool,
        title: `${toolLabel(block.name)}(${argSummary(block.input)})`,
      };
    case 'tool_result':
      return {
        label: block.isError ? 'tool failed' : 'tool ok',
        tone: block.isError ? TONE.error : TONE.tool,
        title: block.toolName ? toolLabel(block.toolName) : undefined,
        body: preview(block.content),
      };
    case 'permission':
      return {
        label: `permission ${block.status}`,
        tone: block.status === 'denied' ? TONE.error : TONE.system,
        title: `${toolLabel(block.toolName)}(${argSummary(block.toolInput)})`,
      };
    case 'system':
      return {
        label: block.subtype ? `system ${block.subtype}` : 'system',
        tone: TONE.system,
        body: block.text || undefined,
      };
    case 'result': {
      const bits: string[] = [];
      if (block.costUsd != null) bits.push(`$${block.costUsd.toFixed(4)}`);
      if (block.inputTokens != null || block.outputTokens != null) {
        bits.push(`${block.inputTokens ?? 0}→${block.outputTokens ?? 0} tok`);
      }
      if (block.denials > 0) bits.push(`${block.denials} denied`);
      return {
        label: block.isError ? 'failed' : 'result',
        tone: block.isError ? TONE.error : TONE.result,
        title: bits.join(' · ') || undefined,
        body: block.summary || undefined,
      };
    }
    default:
      return { label: 'event', tone: TONE.system };
  }
}

/**
 * `mcp__fleet__get_pull_request` reads as `fleet:get_pull_request`. The prefix
 * is the same on every MCP tool and eats the width the actual verb needs.
 */
function toolLabel(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return m ? `${m[1]}:${m[2]}` : name;
}

/**
 * The one or two arguments that identify a call, not the whole payload. A Write
 * with 400 lines of content is still "Write(file_path: …)" to someone scanning
 * for which file it touched; the rest is a click away in the raw view.
 */
function argSummary(input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const entries = Object.entries(input as Record<string, unknown>);
  if (!entries.length) return '';
  const parts: string[] = [];
  for (const [k, v] of entries.slice(0, 3)) {
    parts.push(`${k}: ${scalar(v)}`);
  }
  if (entries.length > 3) parts.push('…');
  return parts.join(', ');
}

function scalar(v: unknown): string {
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v == null) return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  return '{…}';
}

/** Tool output, trimmed to something a reader can skim. */
function preview(content: unknown): string | undefined {
  const text = flatten(content);
  if (!text) return undefined;
  const lines = text.split('\n');
  if (lines.length <= 12) return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  return `${lines.slice(0, 12).join('\n')}\n… ${lines.length - 12} more lines`;
}

/** Tool results arrive as a string, or as the SDK's content-block array. */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (content == null) return '';
  return JSON.stringify(content);
}
