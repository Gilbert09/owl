import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AdminRunEvent } from '@talyn/shared';
import { Transcript } from '../components/fleet/Transcript';

/**
 * The run transcript, readable.
 *
 * What this replaced: one row per raw frame, labelled with the event's `type`
 * and summarised by the first string field anything happened to have. The SDK's
 * events keep their content in `message.content[]`, so an entire agent run
 * rendered as a column of the word "assistant" — you had to expand every row to
 * learn what the agent did.
 */

function ev(seq: number, event: Record<string, unknown>): AdminRunEvent {
  return { seq, at: '2026-08-10T10:00:00.000Z', event } as AdminRunEvent;
}

/**
 * These are REAL fleet frames, captured from hetzner-64's /v1/runs/{id}/events.
 *
 * They are shaped like fvsp.Event — `{ type, subtype?, raw, guestSeq }` — with
 * the SDK's own event nested in `raw`. The first version of this component was
 * tested against hand-written SDK-shaped events instead, which is why it
 * shipped rendering an empty panel next to a live event count: buildBlocks
 * reads `message.content` and a fleet frame keeps that a level down.
 */

const ASSISTANT_TEXT = ev(3, {
  type: 'assistant',
  raw: {
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      id: 'msg_011Cdu1Ba2GBTBBr8b1hrpx7',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: "I'll start by getting the current state of the PR." }],
    },
  },
  guestSeq: 3,
});

const TOOL_CALL = ev(4, {
  type: 'assistant',
  raw: {
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      id: 'msg_011Cdu1Ba2GBTBBr8b1hrpx7',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01EbtsW3kzX8ZEZXyqsc6Yan',
          name: 'mcp__fleet__get_pull_request',
          input: { number: 73754 },
          caller: { type: 'direct' },
        },
      ],
    },
  },
  guestSeq: 4,
});

const TOOL_RESULT = ev(5, {
  type: 'user',
  raw: {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01EbtsW3kzX8ZEZXyqsc6Yan',
          content: 'mergeable: true',
        },
      ],
    },
  },
  guestSeq: 5,
});

const SYSTEM_INIT = ev(1, {
  type: 'system',
  subtype: 'init',
  raw: { type: 'system', subtype: 'init', cwd: '/work/repo', session_id: 'abc' },
  guestSeq: 1,
});

describe('Transcript, readable mode', () => {
  it('shows the agent’s prose instead of the word "assistant"', () => {
    render(<Transcript events={[ASSISTANT_TEXT]} mode="readable" />);
    expect(screen.getByText(/I'll start by getting the current state of the PR/)).toBeTruthy();
  });

  it('names the tool and the arguments that identify the call', () => {
    render(<Transcript events={[TOOL_CALL]} mode="readable" />);
    // The mcp__x__y prefix is noise on every MCP tool and eats the width the
    // verb needs.
    expect(screen.getByText(/fleet:get_pull_request/)).toBeTruthy();
    expect(screen.getByText(/number: 73754/)).toBeTruthy();
  });

  it('pairs a tool result back to the call that caused it', () => {
    render(<Transcript events={[TOOL_CALL, TOOL_RESULT]} mode="readable" />);
    expect(screen.getByText(/mergeable: true/)).toBeTruthy();
    expect(screen.getAllByText(/fleet:get_pull_request/).length).toBeGreaterThan(1);
  });

  /**
   * The whole point of a readable view is that you can still check it against
   * the wire. A view you cannot verify is one you cannot debug a protocol with.
   */
  it('offers the raw frame for a block, keyed by its seq', () => {
    render(<Transcript events={[ASSISTANT_TEXT]} mode="readable" />);
    const toggle = screen.getByText('raw #3');
    fireEvent.click(toggle);
    expect(screen.getByText(/"type": "assistant"/)).toBeTruthy();
    fireEvent.click(screen.getByText('hide raw'));
    expect(screen.queryByText(/"type": "assistant"/)).toBeNull();
  });

  it('marks a failed tool result differently from a successful one', () => {
    const failed = ev(5, {
      type: 'user',
      raw: {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01EbtsW3kzX8ZEZXyqsc6Yan',
              content: 'boom',
              is_error: true,
            },
          ],
        },
      },
    });
    render(<Transcript events={[TOOL_CALL, failed]} mode="readable" />);
    expect(screen.getByText('tool failed')).toBeTruthy();
  });

  it('renders text, never markup, for cross-tenant safety', () => {
    const nasty = ev(1, {
      type: 'assistant',
      raw: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
      },
    });
    const { container } = render(<Transcript events={[nasty]} mode="readable" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });

  it('falls back to raw mode without losing any frame', () => {
    render(<Transcript events={[ASSISTANT_TEXT, TOOL_CALL, TOOL_RESULT]} mode="raw" />);
    for (const seq of ['3', '4', '5']) {
      expect(screen.getByText(seq)).toBeTruthy();
    }
  });

  /**
   * The regression this component shipped with.
   *
   * A fleet frame keeps the SDK event in `raw`; buildBlocks reads
   * `message.content`. Without unwrapping, every frame produced zero blocks and
   * the panel rendered empty beside a header reading "12 events".
   */
  it('unwraps the fleet frame rather than rendering nothing', () => {
    const { container } = render(
      <Transcript events={[SYSTEM_INIT, ASSISTANT_TEXT, TOOL_CALL, TOOL_RESULT]} mode="readable" />
    );
    expect(container.textContent).not.toBe('');
    // One block per meaningful frame, not zero.
    expect(screen.getByText(/I'll start by getting the current state of the PR/)).toBeTruthy();
    expect(screen.getAllByText(/fleet:get_pull_request/).length).toBeGreaterThan(0);
  });

  /** The frame's own type/subtype are what the host guarantees. */
  it('keeps the frame type when raw disagrees or is absent', () => {
    const noRaw = ev(9, { type: 'tool_progress', guestSeq: 9 });
    const { container } = render(<Transcript events={[noRaw]} mode="readable" />);
    // Renders something rather than throwing on a frame with no payload.
    expect(container).toBeTruthy();
  });

  it('survives an empty transcript', () => {
    const { container } = render(<Transcript events={[]} mode="readable" />);
    expect(container.textContent).toBe('');
  });
});
