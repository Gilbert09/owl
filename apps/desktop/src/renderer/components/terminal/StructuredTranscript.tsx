import React, { useEffect, useRef } from 'react';
import type { AgentEvent } from '@fastowl/shared';

interface StructuredTranscriptProps {
  transcript: AgentEvent[] | undefined;
}

/**
 * Slice 1 interim renderer: dump each structured event as a one-line
 * summary so we can validate the plumbing end-to-end. Slice 2 replaces
 * this with `AgentConversation.tsx` (markdown text, collapsible tool
 * calls, inline permission UX).
 */
export function StructuredTranscript({ transcript }: StructuredTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Autoscroll to bottom on new events unless the user scrolled up.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [transcript?.length]);

  if (!transcript || transcript.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground font-mono">
        Waiting for the agent to start…
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-auto px-3 py-2 text-xs font-mono text-foreground/80 bg-[#1e1e1e]"
    >
      {transcript.map((event) => (
        <TranscriptLine key={event.seq} event={event} />
      ))}
    </div>
  );
}

function TranscriptLine({ event }: { event: AgentEvent }) {
  const summary = summarize(event);
  return (
    <div className="py-1 border-b border-white/5 last:border-b-0">
      <span className="text-blue-400">{event.type}</span>
      {event.subtype ? <span className="text-blue-400/60">/{event.subtype}</span> : null}
      <span className="text-muted-foreground"> — </span>
      <span>{summary}</span>
    </div>
  );
}

/**
 * One-line description of an event, picked to let a reviewer see the
 * shape of the run at a glance without expanding blocks. The
 * "stream-json" Claude event schema is intentionally forgiving — we
 * handle the shapes we know and fall back to JSON.
 */
function summarize(event: AgentEvent): string {
  if (event.type === 'assistant' || event.type === 'user') {
    const content = (event.message as { content?: unknown })?.content;
    if (Array.isArray(content)) {
      return content.map(summarizeBlock).join(' · ');
    }
  }
  if (event.type === 'result') {
    const cost =
      typeof event.total_cost_usd === 'number'
        ? ` ($${event.total_cost_usd.toFixed(4)})`
        : '';
    return `${event.result?.slice(0, 180) ?? ''}${cost}`;
  }
  if (event.type === 'system') {
    return String((event as { text?: unknown }).text ?? event.subtype ?? '');
  }
  if (event.type === 'stream_event') {
    const inner = (event.event as { type?: string; delta?: { text?: string } }) ?? {};
    if (inner?.delta?.text) return `Δ ${inner.delta.text.replace(/\n/g, '⏎').slice(0, 160)}`;
    return inner?.type ?? '';
  }
  return '';
}

function summarizeBlock(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as { type?: string; text?: string; name?: string; input?: unknown; is_error?: boolean };
  if (b.type === 'text') return `"${(b.text ?? '').slice(0, 160)}"`;
  if (b.type === 'thinking') return `thinking(...)`;
  if (b.type === 'tool_use') return `→ ${b.name}(${summarizeArgs(b.input)})`;
  if (b.type === 'tool_result') return `← ${b.is_error ? 'err' : 'ok'}`;
  return b.type ?? '';
}

function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input).slice(0, 2);
  return entries
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
    .join(', ');
}
