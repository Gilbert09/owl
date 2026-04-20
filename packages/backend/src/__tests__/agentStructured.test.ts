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

  it('disables on-disk session persistence (we store transcripts server-side)', () => {
    const args = buildClaudeArgs({ ...base, permissionMode: 'bypass' });
    expect(args).toContain('--no-session-persistence');
  });
});
