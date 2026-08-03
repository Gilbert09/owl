// Server-sent-event framing, shared by everything that speaks it.
//
// Three parties now handle the same stream: the fleet client reading a run's
// transcript from fleetd, the admin API proxying that stream on to a browser,
// and the browser reading it. Three hand-rolled buffer-and-split loops is three
// chances to disagree about what a frame is — and the disagreement surfaces as
// "the transcript stops halfway" rather than as an exception, because a
// half-parsed SSE stream looks exactly like a quiet one.
//
// The wire format is deliberately narrow here: `data:` lines carry JSON, blank
// lines separate frames, and anything else is a comment. That is all any of our
// endpoints emit — no `event:`, no `id:`, no multi-line `data:` — so this parser
// implements what we use rather than the whole spec.

/** Frames are separated by a blank line. */
const FRAME_SEPARATOR = '\n\n';
const DATA_PREFIX = 'data: ';

/**
 * A keepalive comment.
 *
 * Idle SSE connections get reaped by intermediaries — Railway's edge does it,
 * and so does fleetd's own upstream. A comment is the cheapest thing that keeps
 * a connection accounted for while carrying no data, and because it is not a
 * `data:` line every parser here ignores it for free.
 */
export const SSE_KEEPALIVE_FRAME = ': ping\n\n';

/** Serialize one JSON payload as an SSE frame. The only writer we have. */
export function formatSseFrame(payload: unknown): string {
  return `${DATA_PREFIX}${JSON.stringify(payload)}${FRAME_SEPARATOR}`;
}

export interface SseJsonParser<T> {
  /**
   * Feed a decoded chunk. Returns every complete frame the buffer now holds —
   * possibly none, possibly several, since chunk boundaries and frame
   * boundaries are unrelated.
   */
  push(chunk: string): T[];
}

/**
 * A stateful parser that turns a stream of text chunks into JSON payloads.
 *
 * A malformed frame is DROPPED, not thrown. Every consumer of this has a slower
 * but authoritative path underneath — the fleet poller holds the same cursor,
 * and the browser can refetch the range — so killing the stream over one bad
 * frame trades a recoverable gap for an unrecoverable one.
 */
export function createSseJsonParser<T = unknown>(): SseJsonParser<T> {
  let buffer = '';
  return {
    push(chunk: string): T[] {
      buffer += chunk;
      const out: T[] = [];
      let sep: number;
      while ((sep = buffer.indexOf(FRAME_SEPARATOR)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + FRAME_SEPARATOR.length);
        for (const line of frame.split('\n')) {
          if (!line.startsWith(DATA_PREFIX)) continue;
          try {
            out.push(JSON.parse(line.slice(DATA_PREFIX.length)) as T);
          } catch {
            // See the docblock: a bad frame is a gap, not a failure.
          }
        }
      }
      return out;
    },
  };
}
