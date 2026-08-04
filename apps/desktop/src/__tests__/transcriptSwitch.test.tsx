import { render, screen } from '@testing-library/react';
import type { AgentEvent } from '@talyn/shared';
import { AgentConversation } from '../renderer/components/terminal/AgentConversation';

/**
 * Switching between tasks must switch the transcript.
 *
 * The bug: three fleet tasks were started on three different PRs, and all
 * three task screens showed the same PR's tool calls. The backend was
 * blameless — each task's prompt, its fleet run and its stored transcript
 * named its own PR. The renderer was showing the wrong one.
 *
 * Two things combined:
 *
 *  1. `<TaskTerminal task={task} />` had no `key`, so selecting a different
 *     task reused the same component instance and the AgentConversation
 *     beneath it.
 *  2. Block React keys are built from the source event's `seq` — and `seq`
 *     restarts at 1 for every cloud run. So block "3.0" of one task and
 *     block "3.0" of another are different content behind an identical key.
 *     React reconciled old onto new by key, `BlockView`'s memo comparator
 *     saw an unchanged signature, and skipped the re-render.
 *
 * Text blocks include their length in the signature, so prose usually
 * refreshed — which is why the screen looked half-right: the sentence
 * updated while the tool rows underneath it still named the previous PR.
 *
 * These render the SAME component instance with two transcripts, which is
 * exactly what the missing key allowed. The mount site is keyed now, but a
 * component that is only correct because of how it happens to be mounted is
 * a trap for the next caller.
 */

function toolUse(seq: number, name: string, input: Record<string, unknown>): AgentEvent {
  return {
    seq,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_${seq}`, name, input }],
    },
  } as unknown as AgentEvent;
}

describe('switching transcripts in one AgentConversation instance', () => {
  it('shows the new task’s tool calls, not the previous task’s', () => {
    // Both transcripts start at seq 1 — the collision that caused this.
    const taskA = [toolUse(1, 'mcp__fleet__get_pull_request', { number: 73784 })];
    const taskB = [toolUse(1, 'mcp__fleet__get_pull_request', { number: 73785 })];

    const { rerender } = render(
      <AgentConversation scopeId="task-a" transcript={taskA} />
    );
    expect(screen.getByText(/73784/)).toBeTruthy();

    rerender(<AgentConversation scopeId="task-b" transcript={taskB} />);

    expect(screen.queryByText(/73784/)).toBeNull();
    expect(screen.getByText(/73785/)).toBeTruthy();
  });

  it('still re-renders correctly across several colliding blocks', () => {
    const a = [
      toolUse(1, 'mcp__fleet__get_pull_request', { number: 111 }),
      toolUse(2, 'mcp__fleet__list_review_threads', { number: 111 }),
      toolUse(3, 'mcp__fleet__wait_for_checks', { sha: 'aaa' }),
    ];
    const b = [
      toolUse(1, 'mcp__fleet__get_pull_request', { number: 222 }),
      toolUse(2, 'mcp__fleet__list_review_threads', { number: 222 }),
      toolUse(3, 'mcp__fleet__wait_for_checks', { sha: 'bbb' }),
    ];

    const { rerender } = render(<AgentConversation scopeId="a" transcript={a} />);
    rerender(<AgentConversation scopeId="b" transcript={b} />);

    expect(screen.queryByText(/111/)).toBeNull();
    expect(screen.queryByText(/aaa/)).toBeNull();
    expect(screen.getAllByText(/222/).length).toBeGreaterThan(0);
  });

  it('does not re-render when nothing changed', () => {
    // The memo still has to do its job — this whole mechanism exists because
    // an agent emits dozens of events a second and re-rendering a settled
    // transcript per event was the "task screen feels sluggish" complaint.
    const events = [toolUse(1, 'mcp__fleet__get_pull_request', { number: 999 })];
    const { rerender } = render(<AgentConversation scopeId="same" transcript={events} />);
    const before = screen.getByText(/999/);

    rerender(<AgentConversation scopeId="same" transcript={events} />);

    // Same DOM node, i.e. React reused it rather than rebuilding.
    expect(screen.getByText(/999/)).toBe(before);
  });
});
