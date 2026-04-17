import { describe, it, expect, afterEach } from 'vitest';
import { buildFastOwlEnvPrefix } from '../services/agent.js';

describe('buildFastOwlEnvPrefix', () => {
  const originalUrl = process.env.FASTOWL_API_URL;
  const originalPort = process.env.PORT;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.FASTOWL_API_URL;
    else process.env.FASTOWL_API_URL = originalUrl;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it('emits API URL and workspace id', () => {
    delete process.env.FASTOWL_API_URL;
    process.env.PORT = '4747';
    const prefix = buildFastOwlEnvPrefix('ws-1');
    expect(prefix).toContain(`FASTOWL_API_URL='http://localhost:4747'`);
    expect(prefix).toContain(`FASTOWL_WORKSPACE_ID='ws-1'`);
    expect(prefix).not.toContain('FASTOWL_TASK_ID');
    expect(prefix.endsWith(' ')).toBe(true);
  });

  it('includes task id when given', () => {
    const prefix = buildFastOwlEnvPrefix('ws-1', 't-42');
    expect(prefix).toContain(`FASTOWL_TASK_ID='t-42'`);
  });

  it('honors FASTOWL_API_URL override', () => {
    process.env.FASTOWL_API_URL = 'https://fastowl.example.com';
    const prefix = buildFastOwlEnvPrefix('ws-1');
    expect(prefix).toContain(`FASTOWL_API_URL='https://fastowl.example.com'`);
  });

  it('escapes single quotes in values', () => {
    const prefix = buildFastOwlEnvPrefix(`ws-it's-quoted`);
    // The escaped form is: 'ws-it'\''s-quoted'
    expect(prefix).toContain(`FASTOWL_WORKSPACE_ID='ws-it'\\''s-quoted'`);
  });

  it('omits FASTOWL_API_URL for SSH environments (includeApiUrl=false)', () => {
    const prefix = buildFastOwlEnvPrefix('ws-1', 't-1', { includeApiUrl: false });
    expect(prefix).not.toContain('FASTOWL_API_URL');
    expect(prefix).toContain(`FASTOWL_WORKSPACE_ID='ws-1'`);
    expect(prefix).toContain(`FASTOWL_TASK_ID='t-1'`);
  });
});
