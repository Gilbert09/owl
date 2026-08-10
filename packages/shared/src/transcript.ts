/**
 * The transcript block model, shared by every surface that renders an agent run.
 *
 * The event stream is event-shaped; a reader wants a block shape — one card per
 * assistant turn, tool call, permission prompt or result. `buildBlocks`
 * collapses the flat list into that, pairing each `tool_result` back to the
 * `tool_use` that caused it so a collapsed row can say what the tool DID rather
 * than dumping its bytes.
 *
 * It lives here because three apps render the same stream and the logic is
 * pure. apps/web and apps/desktop carried byte-identical copies of it; the
 * admin console needed a third, which is the point at which a copy becomes a
 * bug waiting to be fixed twice.
 *
 * Deliberately free of React and of any HTML rendering. The admin console shows
 * cross-tenant data and renders transcripts as text on purpose, so the shared
 * layer must not decide how text becomes markup.
 */
import type { AgentEvent } from './index.js';

// ---------------------------------------------------------------------------
// Block model — the transcript is event-stream shaped; the renderer wants a
// block-stream shape (one "card" per assistant turn, tool call, permission
// prompt, etc.). `buildBlocks` collapses a flat event list into this shape.
// ---------------------------------------------------------------------------

export type Block =
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

export function buildBlocks(events: AgentEvent[]): Block[] {
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

    if (event.type === 'talyn_permission_request') {
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

    if (event.type === 'talyn_permission_auto_allowed') {
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

    if (event.type === 'talyn_permission_response') {
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

/**
 * Cheap render-affecting signature for a block. Most blocks are
 * immutable once created (their `key` encodes the source event's seq +
 * index), so the key alone is a stable identity. The two exceptions:
 *  - permission cards mutate in place (pending → allowed/denied), and
 *  - the live streaming-text tail grows token by token.
 * Including those mutable fields lets React.memo skip every settled
 * block on each per-frame transcript update while still re-rendering
 * the handful that actually changed.
 *
 * "The key alone is a stable identity" is true WITHIN one transcript and
 * false across two. `seq` restarts at 1 for every cloud run, so block
 * `"3.0"` of one task and block `"3.0"` of another are different content
 * behind identical keys. React then reconciles the old element onto the
 * new one by key, this comparator reports no change, and the previous
 * task's tool calls stay on screen under the new task's header — three
 * concurrent PR tasks all appeared to be working on the same PR.
 *
 * `scopeId` is what makes the identity whole. The mount site also keys
 * TaskTerminal by task id so this cannot arise there any more, but a
 * signature that is only correct because of where it happens to be
 * called from is a trap for the next caller.
 */
export function blockSignature(block: Block): string {
  switch (block.kind) {
    case 'permission':
      return `${block.key}|${block.status}|${block.persist ? 1 : 0}`;
    case 'text':
      // Settled text blocks have a stable key + length; the streaming
      // tail keeps the same key while its length grows.
      return `${block.key}|${block.text.length}`;
    default:
      return block.key;
  }
}
