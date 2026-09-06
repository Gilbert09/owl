import { beforeEach, describe, it, expect } from 'vitest';
import {
  buildBlocks,
  describeTool,
  formatToolOutput,
  groupToolRuns,
  groupedBlockSignature,
  mergeToolBlocks,
  mergedBlockSignature,
  type AgentEvent,
} from '@talyn/shared';

/**
 * The transcript block model, as the task terminal reads it.
 *
 * Three things are pinned here, all of which were visibly wrong on screen
 * before: assistant text appearing twice, a tool call and its output rendering
 * as two unrelated rows, and every fleet tool row reading `bash command=…` with
 * the command severed mid-word.
 */

let seq = 0;
function assistant(content: unknown[], id?: string): AgentEvent {
  return { seq: ++seq, type: 'assistant', message: { id, role: 'assistant', content } };
}
function toolResult(toolUseId: string, content: unknown, isError = false): AgentEvent {
  return {
    seq: ++seq,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  };
}
function delta(text: string): AgentEvent {
  return {
    seq: ++seq,
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
}

/**
 * The duplication bug.
 *
 * The accumulator was cleared only when an `assistant` event's `message.id`
 * MATCHED the id captured at `message_start`. The fleet's guest converter emits
 * `id: msg.responseId ?? undefined`, and a provider sending deltas without a
 * `message_start` never sets the id at all — so it was never cleared, kept
 * every turn's text for the whole run, and rendered all of it concatenated as a
 * tail block. Each message appeared twice: once in place, once again run
 * together at the bottom.
 */
describe('streaming text', () => {
  it('does not repeat a finished turn as a tail block when ids are absent', () => {
    seq = 0;
    const blocks = buildBlocks([
      delta('Looking at the failing checks.'),
      assistant([{ type: 'text', text: 'Looking at the failing checks.' }]),
      delta('Need a deeper fetch.'),
      assistant([{ type: 'text', text: 'Need a deeper fetch.' }]),
    ]);

    const texts = blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text);
    expect(texts).toEqual(['Looking at the failing checks.', 'Need a deeper fetch.']);
    // Specifically: nothing carrying BOTH turns run together.
    expect(texts.some((t) => t.includes('checks.Need'))).toBe(false);
  });

  it('still shows an in-flight turn that has no assistant event yet', () => {
    seq = 0;
    const blocks = buildBlocks([
      assistant([{ type: 'text', text: 'Done thinking.' }]),
      delta('Now I will '),
      delta('read the file.'),
    ]);
    const texts = blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text);
    expect(texts).toEqual(['Done thinking.', 'Now I will read the file.']);
  });
});

/**
 * Tool names differ per provider and the renderer used to switch on Claude
 * Code's TitleCase set alone, so every fleet run (Pi's lowercase names) missed
 * every case and fell through to a `key=value` dump.
 */
describe('describeTool', () => {
  it.each([
    ['Bash', 'bash'],
    ['bash', 'bash'],
    ['shell', 'bash'],
    ['run_command', 'bash'],
    ['Read', 'read'],
    ['read_file', 'read'],
    ['str_replace_editor', 'edit'],
    ['MultiEdit', 'edit'],
    ['Grep', 'grep'],
    ['ripgrep', 'grep'],
    ['WebFetch', 'fetch'],
  ])('normalises %s to %s', (name, expected) => {
    expect(describeTool(name, {}).label).toBe(expected);
  });

  it('reads the command whatever the argument is called', () => {
    for (const key of ['command', 'cmd', 'script']) {
      const d = describeTool('bash', { [key]: 'git status' });
      expect(d.detail).toBe('git status');
      expect(d.isCommand).toBe(true);
    }
  });

  it('returns the command WHOLE — truncation is the renderer’s job', () => {
    const cmd = 'cd /work && rm -rf posthog && git clone --depth 1 https://github.com/PostHog/posthog';
    expect(describeTool('bash', { command: cmd }).detail).toBe(cmd);
  });

  it('flattens a multi-line command onto one line', () => {
    expect(describeTool('bash', { command: 'set -e\n\n  npm test\n' }).detail).toBe('set -e npm test');
  });

  it('keeps an unknown tool’s own name rather than guessing a verb', () => {
    const d = describeTool('mcp__linear__create_issue', { title: 'Fix the thing' });
    expect(d.label).toBe('mcp__linear__create_issue');
    // ...and still finds something readable to say about it.
    expect(d.detail).toBe('Fix the thing');
    expect(d.isCommand).toBe(false);
  });

  /**
   * MCP tools are commonly called with a single NUMERIC argument. Taking only
   * strings left those rows with no subject, so three tool calls naming three
   * different PRs rendered as three identical lines.
   */
  it('shows a scalar argument, not just a string one', () => {
    expect(describeTool('mcp__fleet__get_pull_request', { number: 73784 }).detail).toBe('73784');
    expect(describeTool('some_tool', { enabled: true }).detail).toBe('true');
  });

  it('says nothing rather than something wrong when there is no subject', () => {
    // An object argument inlines as `[object Object]`, which is worse than
    // silence at this size.
    expect(describeTool('TodoWrite', { todos: [1, 2] }).detail).toBe('');
  });
});

describe('mergeToolBlocks', () => {
  it('folds a result into the call that caused it', () => {
    seq = 0;
    const merged = mergeToolBlocks(
      buildBlocks([
        assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }]),
        toolResult('t1', 'a.txt\nb.txt'),
      ])
    );

    expect(merged).toHaveLength(1);
    const tool = merged[0] as { kind: string; name: string; output: unknown; settled: boolean };
    expect(tool.kind).toBe('tool');
    expect(tool.name).toBe('bash');
    expect(tool.output).toBe('a.txt\nb.txt');
    expect(tool.settled).toBe(true);
  });

  it('leaves an in-flight call unsettled so the row can show it running', () => {
    seq = 0;
    const merged = mergeToolBlocks(
      buildBlocks([assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }])])
    );
    const tool = merged[0] as { settled: boolean; output: unknown };
    expect(tool.settled).toBe(false);
    expect(tool.output).toBeUndefined();
  });

  it('carries the error flag onto the CALL, not onto the output', () => {
    seq = 0;
    const merged = mergeToolBlocks(
      buildBlocks([
        assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'false' } }]),
        toolResult('t1', 'boom', true),
      ])
    );
    expect((merged[0] as { isError: boolean }).isError).toBe(true);
  });

  // A truncated transcript, or a run adopted mid-flight, can carry a result
  // whose call we never saw. Dropping it would silently lose output.
  it('keeps an orphan result rather than discarding it', () => {
    seq = 0;
    const merged = mergeToolBlocks(buildBlocks([toolResult('gone', 'output nobody asked for')]));
    expect(merged).toHaveLength(1);
    expect((merged[0] as { output: unknown }).output).toBe('output nobody asked for');
  });

  it('interleaves calls and prose in order', () => {
    seq = 0;
    const merged = mergeToolBlocks(
      buildBlocks([
        assistant([{ type: 'text', text: 'First I look.' }]),
        assistant([{ type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/a.ts' } }]),
        toolResult('t1', 'contents'),
        assistant([{ type: 'text', text: 'Now I know.' }]),
      ])
    );
    expect(merged.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
  });

  /**
   * A tool block MUTATES when its result lands while keeping the key of the
   * call, so memoising on the key alone leaves every row spinning forever.
   */
  it('changes signature when a call settles', () => {
    seq = 0;
    const events = [assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }])];
    const before = mergedBlockSignature(mergeToolBlocks(buildBlocks(events))[0]);
    const after = mergedBlockSignature(
      mergeToolBlocks(buildBlocks([...events, toolResult('t1', 'done')]))[0]
    );
    expect(before).not.toBe(after);
  });
});

/**
 * How much of a tool's output goes on screen.
 *
 * The bug: the renderer clamped at six LINES, and a GitHub API response is
 * ~1.5 KB of minified JSON on ONE line. It sailed through the clamp and wrapped
 * to twenty rows of unreadable punctuation.
 */
describe('formatToolOutput', () => {
  const pr = JSON.stringify({
    url: 'https://api.github.com/repos/PostHog/posthog/pulls/95755',
    number: 95755,
    user: { login: 'Gilbert09', id: 1459269 },
  });

  it('measures characters as well as lines', () => {
    const out = formatToolOutput('x'.repeat(4000));
    expect(out.lines).toBe(1);
    // The measure the old clamp lacked, and the whole reason it did nothing.
    expect(out.chars).toBe(4000);
  });

  it('pretty-prints a JSON object so it can be read at all', () => {
    const out = formatToolOutput(pr);
    expect(out.isJson).toBe(true);
    expect(out.lines).toBeGreaterThan(1);
    expect(out.text).toContain('"number": 95755');
    expect(out.summary).toMatch(/^JSON · /);
  });

  it('leaves a scalar alone — pretty-printing it changes nothing', () => {
    for (const v of ['42', 'true', '"hello"']) {
      expect(formatToolOutput(v).isJson).toBe(false);
    }
  });

  it('leaves truncated JSON exactly as it came', () => {
    // A half-parsed document is worse than the raw bytes.
    const broken = '{"url":"https://api.github.com/repos/PostHog/pos';
    const out = formatToolOutput(broken);
    expect(out.isJson).toBe(false);
    expect(out.text).toBe(broken);
  });

  it('unwraps the [{type:text}] content shape a subagent returns', () => {
    const out = formatToolOutput([{ type: 'text', text: 'line one\nline two' }]);
    expect(out.text).toBe('line one\nline two');
    expect(out.lines).toBe(2);
  });

  it('says nothing about output that is not there', () => {
    expect(formatToolOutput(undefined).summary).toBe('');
    expect(formatToolOutput('').text).toBe('');
  });

  it('survives a cyclic object rather than throwing inside a render', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatToolOutput(cyclic)).not.toThrow();
  });
});

/**
 * An agent does several things to answer one sentence. Rendering each as a
 * top-level row buries the sentences that explain them.
 */
describe('groupToolRuns', () => {
  let s = 0;
  const use = (id: string, name: string, input: Record<string, unknown>): AgentEvent =>
    ({
      seq: ++s,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    }) as AgentEvent;
  const res = (id: string, c: string, e = false): AgentEvent =>
    ({
      seq: ++s,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: c, is_error: e }] },
    }) as AgentEvent;
  const say = (t: string): AgentEvent =>
    ({ seq: ++s, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } }) as AgentEvent;

  const grouped = (events: AgentEvent[]) => groupToolRuns(mergeToolBlocks(buildBlocks(events)));

  beforeEach(() => {
    s = 0;
  });

  it('folds consecutive calls into one section', () => {
    const out = grouped([
      use('a', 'bash', { command: 'ls' }),
      res('a', 'ok'),
      use('b', 'bash', { command: 'pwd' }),
      res('b', '/work'),
      use('c', 'read', { file_path: '/a.ts' }),
      res('c', 'x'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('tool_group');
    expect((out[0] as { summary: string }).summary).toBe('Ran 2 commands, read a file');
  });

  /** Prose is the boundary a reader thinks in: "it said this, did these, said that". */
  it('breaks a run on prose', () => {
    const out = grouped([
      use('a', 'bash', { command: 'ls' }),
      res('a', 'ok'),
      say('Now the tests.'),
      use('b', 'bash', { command: 'pytest' }),
      res('b', 'ok'),
    ]);
    expect(out.map((b) => b.kind)).toEqual(['tool', 'text', 'tool']);
  });

  /** A lone call is not a "run"; hiding it costs a click to learn one line. */
  it('leaves a single call ungrouped', () => {
    const out = grouped([use('a', 'bash', { command: 'ls' }), res('a', 'ok')]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('tool');
  });

  it('reports a failure on the closed group, so it can open itself', () => {
    const out = grouped([
      use('a', 'bash', { command: 'ls' }),
      res('a', 'ok'),
      use('b', 'bash', { command: 'false' }),
      res('b', 'boom', true),
    ]);
    expect((out[0] as { isError: boolean }).isError).toBe(true);
  });

  it('reports a run as running while any call is in flight', () => {
    const out = grouped([
      use('a', 'bash', { command: 'ls' }),
      res('a', 'ok'),
      use('b', 'bash', { command: 'sleep 60' }),
    ]);
    expect((out[0] as { running: boolean }).running).toBe(true);
  });

  it('counts by canonical verb, not by tool name', () => {
    const out = grouped([
      use('a', 'Bash', { command: 'ls' }),
      res('a', 'ok'),
      use('b', 'run_command', { cmd: 'pwd' }),
      res('b', 'ok'),
      use('c', 'shell', { script: 'id' }),
      res('c', 'ok'),
    ]);
    expect((out[0] as { summary: string }).summary).toBe('Ran 3 commands');
  });

  it('collapses unknown tools into one honest count', () => {
    const out = grouped([
      use('a', 'mcp__fleet__get_pull_request', { number: 1 }),
      res('a', '{}'),
      use('b', 'mcp__linear__create_issue', { title: 'x' }),
      res('b', '{}'),
    ]);
    expect((out[0] as { summary: string }).summary).toBe('2 tool calls');
  });

  /** A group mutates as its calls settle; memoising on the key alone would
   *  leave an open group frozen mid-run. */
  it('changes signature when a call inside settles', () => {
    const events = [use('a', 'bash', { command: 'ls' }), use('b', 'bash', { command: 'pwd' })];
    const before = groupedBlockSignature(grouped(events)[0]);
    s = 0;
    const after = groupedBlockSignature(grouped([...events, res('b', 'done')])[0]);
    expect(before).not.toBe(after);
  });
});
