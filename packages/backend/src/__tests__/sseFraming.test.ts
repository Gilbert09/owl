/**
 * Pins @talyn/shared's SSE framing.
 *
 * Three parties parse this stream — the fleet client reading a transcript from
 * fleetd, the admin API proxying it on, and the browser reading the proxy — and
 * before the extraction each had its own buffer-and-split loop. A disagreement
 * between them does not throw: it shows up as "the transcript stops halfway",
 * which is indistinguishable from a quiet agent. These cases exist so the
 * shared implementation cannot regress into that silently.
 */
import { describe, it, expect } from 'vitest';
import { createSseJsonParser, formatSseFrame, SSE_KEEPALIVE_FRAME } from '@talyn/shared';

describe('createSseJsonParser', () => {
  it('parses a whole frame delivered in one chunk', () => {
    const parser = createSseJsonParser<{ n: number }>();
    expect(parser.push('data: {"n":1}\n\n')).toEqual([{ n: 1 }]);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    // The real failure mode: TCP chunk boundaries have nothing to do with
    // frame boundaries, so a parser that assumes one chunk = one frame drops
    // every event that happens to straddle a read.
    const parser = createSseJsonParser<{ n: number }>();
    expect(parser.push('data: {"n')).toEqual([]);
    expect(parser.push('":42}')).toEqual([]);
    expect(parser.push('\n\n')).toEqual([{ n: 42 }]);
  });

  it('returns every frame when several arrive in one chunk', () => {
    const parser = createSseJsonParser<{ n: number }>();
    expect(parser.push('data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n')).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
  });

  it('holds a trailing partial frame for the next push', () => {
    const parser = createSseJsonParser<{ n: number }>();
    expect(parser.push('data: {"n":1}\n\ndata: {"n":2}')).toEqual([{ n: 1 }]);
    expect(parser.push('\n\n')).toEqual([{ n: 2 }]);
  });

  it('ignores keepalive comments without disturbing the buffer', () => {
    // fleetd and our own proxy both send `: ping` through idle gaps. A parser
    // that treats a comment as data emits garbage; one that mishandles the
    // framing loses the next real frame with it.
    const parser = createSseJsonParser<{ n: number }>();
    expect(parser.push(SSE_KEEPALIVE_FRAME)).toEqual([]);
    expect(parser.push(SSE_KEEPALIVE_FRAME + 'data: {"n":7}\n\n')).toEqual([{ n: 7 }]);
  });

  it('drops a malformed frame and keeps going', () => {
    // Deliberate: every consumer has an authoritative cursor underneath, so a
    // bad frame should cost one event, not the rest of the stream.
    const parser = createSseJsonParser<{ n: number }>();
    expect(parser.push('data: {not json\n\ndata: {"n":9}\n\n')).toEqual([{ n: 9 }]);
  });

  it.each([
    ['empty chunk', ''],
    ['bare newlines', '\n\n'],
    ['a non-data line', 'event: message\n\n'],
  ])('yields nothing for %s', (_label, chunk) => {
    expect(createSseJsonParser().push(chunk)).toEqual([]);
  });

  it('round-trips whatever formatSseFrame writes', () => {
    // The writer and the reader must agree; they are the two halves of the
    // proxy, and this is the only place that fact is checked.
    const payload = { events: [{ seq: 1, at: 'now', event: { type: 'text' } }], cursor: 1, terminal: false };
    const parser = createSseJsonParser<typeof payload>();
    expect(parser.push(formatSseFrame(payload))).toEqual([payload]);
  });

  it('round-trips a payload containing the frame separator', () => {
    // A transcript carries agent output, and agent output contains blank
    // lines. JSON escapes them to \n\n inside the string, so framing survives
    // — but only because the writer serialises rather than concatenating.
    const payload = { text: 'line one\n\nline two' };
    const parser = createSseJsonParser<typeof payload>();
    expect(parser.push(formatSseFrame(payload))).toEqual([payload]);
  });
});
