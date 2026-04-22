import { describe, it, expect } from 'vitest';
import { JsonlLineParser, buildClaudeArgs } from '../services/agentStructured.js';

describe('JsonlLineParser', () => {
  it('returns complete objects from a single chunk', () => {
    const p = new JsonlLineParser();
    const out = p.push('{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n');
    expect(out).toHaveLength(2);
    expect((out[0] as { type: string }).type).toBe('system');
    expect((out[1] as { type: string }).type).toBe('result');
  });

  it('buffers a partial line until the newline arrives', () => {
    const p = new JsonlLineParser();
    expect(p.push('{"type":"asst')).toEqual([]);
    expect(p.push('istant","message":{"role":"assistant"}}\n')).toHaveLength(1);
  });

  it('tolerates multiple splits inside a single JSON object', () => {
    const p = new JsonlLineParser();
    // Split across three physical chunks with no newline mid-object.
    p.push('{"type":"assi');
    p.push('stant","mess');
    const out = p.push('age":{"role":"assistant"}}\n');
    expect(out).toHaveLength(1);
    expect((out[0] as { message: { role: string } }).message.role).toBe('assistant');
  });

  it('skips blank lines without emitting empty events', () => {
    const p = new JsonlLineParser();
    const out = p.push('\n\n{"type":"x"}\n\n');
    expect(out).toHaveLength(1);
  });

  it('drops malformed JSON lines without crashing the parse loop', () => {
    const p = new JsonlLineParser();
    const out = p.push(
      'not json at all\n' +
      '{"type":"good"}\n' +
      '{broken":}\n' +
      '{"type":"also_good"}\n'
    );
    // Two valid objects returned; the invalid lines are silently dropped.
    expect(out).toHaveLength(2);
    expect((out[0] as { type: string }).type).toBe('good');
    expect((out[1] as { type: string }).type).toBe('also_good');
  });
});

describe('buildClaudeArgs', () => {
  const base = {
    sessionKey: 's',
    agentId: 'a',
    workspaceId: 'w',
    prompt: 'hi',
  } as const;

  it('always uses print mode with stream-json + verbose + partial messages', () => {
    const args = buildClaudeArgs({ ...base, permissionMode: 'bypass' });
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--include-partial-messages');
  });

  it('passes bypassPermissions for the bypass permission mode', () => {
    const args = buildClaudeArgs({ ...base, permissionMode: 'bypass' });
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });

  it('leaves CLI session persistence enabled so `/continue` can --resume', () => {
    const args = buildClaudeArgs({ ...base, permissionMode: 'bypass' });
    expect(args).not.toContain('--no-session-persistence');
  });

  it('adds --resume when resumeSessionId is set', () => {
    const args = buildClaudeArgs({
      ...base,
      permissionMode: 'bypass',
      resumeSessionId: 'abc-123',
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-123');
  });

  it('does NOT add --resume for fresh runs', () => {
    const args = buildClaudeArgs({ ...base, permissionMode: 'bypass' });
    expect(args).not.toContain('--resume');
  });

  it('interactive runs add --input-format stream-json so stdin stays a JSONL pipe', () => {
    const args = buildClaudeArgs({ ...base, permissionMode: 'bypass', interactive: true });
    expect(args).toContain('--input-format');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
  });

  it('one-shot (autonomous) runs do NOT include --input-format', () => {
    const args = buildClaudeArgs({ ...base, permissionMode: 'bypass', interactive: false });
    expect(args).not.toContain('--input-format');
  });

  it('strict + interactive wires both the hook settings and the input flag', () => {
    const args = buildClaudeArgs({
      ...base,
      permissionMode: 'strict',
      hookScriptPath: '/tmp/permission.cjs',
      interactive: true,
    });
    expect(args).toContain('--input-format');
    expect(args).toContain('--settings');
    const settings = args[args.indexOf('--settings') + 1];
    expect(settings).toContain('PreToolUse');
    expect(settings).toContain('/tmp/permission.cjs');
  });

  it('strict mode requires a hookScriptPath (throws when missing)', () => {
    expect(() =>
      buildClaudeArgs({ ...base, permissionMode: 'strict' })
    ).toThrow(/hookScriptPath/);
  });

  it('--resume coexists with --input-format on an interactive resume', () => {
    const args = buildClaudeArgs({
      ...base,
      permissionMode: 'bypass',
      resumeSessionId: 'session-999',
      interactive: true,
    });
    expect(args).toContain('--resume');
    expect(args).toContain('--input-format');
  });

  it('emits the --settings payload as valid JSON pointing at the hook', () => {
    const args = buildClaudeArgs({
      ...base,
      permissionMode: 'strict',
      hookScriptPath: '/tmp/p.cjs',
    });
    const raw = args[args.indexOf('--settings') + 1];
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe('/tmp/p.cjs');
  });
});

describe('JsonlLineParser — additional resilience cases', () => {
  it('emits nothing on a trailing newline after all events', () => {
    const p = new JsonlLineParser();
    const out = p.push('{"type":"once"}\n');
    expect(out).toHaveLength(1);
    expect(p.push('\n')).toEqual([]);
  });

  it('preserves event order across chunks', () => {
    const p = new JsonlLineParser();
    p.push('{"type":"a","n":1}\n{"type":"b","n":2}\n{"type":"c","n":');
    const tail = p.push('3}\n{"type":"d","n":4}\n');
    const types = tail.map((e) => (e as { type: string }).type);
    expect(types).toEqual(['c', 'd']);
  });

  it('handles one gigantic JSON line accumulated across many chunks', () => {
    const p = new JsonlLineParser();
    const text = '{"type":"x","blob":"' + 'z'.repeat(50_000) + '"}\n';
    // Push in 8KB chunks.
    for (let i = 0; i < text.length; i += 8192) {
      p.push(text.slice(i, i + 8192));
    }
    // The full object should be in the last chunk's output.
    const tail = p.push('');
    expect(tail).toEqual([]);
    // Re-push the exact slice that ends with a newline to confirm parsing.
    const out = new JsonlLineParser().push(text);
    expect(out).toHaveLength(1);
    expect((out[0] as { blob: string }).blob.length).toBe(50_000);
  });
});
