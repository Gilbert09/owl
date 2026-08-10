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

const ASSISTANT_TEXT = ev(1, {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Rebasing onto origin/master.' }] },
});

const TOOL_CALL = ev(2, {
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'mcp__fleet__get_pull_request',
        input: { number: 79258, repo: 'PostHog/posthog' },
      },
    ],
  },
});

const TOOL_RESULT = ev(3, {
  type: 'user',
  message: {
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'mergeable: true' }],
  },
});

describe('Transcript, readable mode', () => {
  it('shows the agent’s prose instead of the word "assistant"', () => {
    render(<Transcript events={[ASSISTANT_TEXT]} mode="readable" />);
    expect(screen.getByText(/Rebasing onto origin\/master/)).toBeTruthy();
  });

  it('names the tool and the arguments that identify the call', () => {
    render(<Transcript events={[TOOL_CALL]} mode="readable" />);
    // The mcp__x__y prefix is noise on every MCP tool and eats the width the
    // verb needs.
    expect(screen.getByText(/fleet:get_pull_request/)).toBeTruthy();
    expect(screen.getByText(/number: 79258/)).toBeTruthy();
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
    const toggle = screen.getByText('raw #1');
    fireEvent.click(toggle);
    expect(screen.getByText(/"type": "assistant"/)).toBeTruthy();
    fireEvent.click(screen.getByText('hide raw'));
    expect(screen.queryByText(/"type": "assistant"/)).toBeNull();
  });

  it('marks a failed tool result differently from a successful one', () => {
    const failed = ev(3, {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'boom', is_error: true },
        ],
      },
    });
    render(<Transcript events={[TOOL_CALL, failed]} mode="readable" />);
    expect(screen.getByText('tool failed')).toBeTruthy();
  });

  it('renders text, never markup, for cross-tenant safety', () => {
    const nasty = ev(1, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
    });
    const { container } = render(<Transcript events={[nasty]} mode="readable" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });

  it('falls back to raw mode without losing any frame', () => {
    render(<Transcript events={[ASSISTANT_TEXT, TOOL_CALL, TOOL_RESULT]} mode="raw" />);
    for (const seq of ['1', '2', '3']) {
      expect(screen.getByText(seq)).toBeTruthy();
    }
  });

  it('survives an empty transcript', () => {
    const { container } = render(<Transcript events={[]} mode="readable" />);
    expect(container.textContent).toBe('');
  });
});
