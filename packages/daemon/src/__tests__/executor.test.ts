import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  run,
  streamSpawn,
  writeSession,
  killSession,
  closeStreamInput,
  setChildEnv,
  listActiveSessions,
  shutdownAllSessions,
} from '../executor.js';

// The executor requires bare binary names (no path separators). `node`
// is on both the stream and internal-run allowlists — CI always has it
// on PATH since the test runner itself is node.
const NODE = 'node';
const TMP = path.join(os.tmpdir(), `fastowl-daemon-exec-test-${randomBytes(4).toString('hex')}`);

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  shutdownAllSessions();
  setChildEnv({});
  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
});

describe('run — argv + stdio + error paths', () => {
  it('returns stdout, stderr, and exit code for a simple node script', async () => {
    const res = await run(NODE, ['-e', 'process.stdout.write("hi"); process.stderr.write("er"); process.exit(3)']);
    expect(res.stdout).toBe('hi');
    expect(res.stderr).toBe('er');
    expect(res.code).toBe(3);
  });

  it('writes stdinBase64 to the child and closes stdin', async () => {
    // Node script reads all of stdin and echoes it back.
    const script =
      'let buf=""; process.stdin.setEncoding("utf8"); ' +
      'process.stdin.on("data",(c)=>buf+=c); ' +
      'process.stdin.on("end",()=>process.stdout.write(buf));';
    const res = await run(NODE, ['-e', script], {
      stdinBase64: Buffer.from('hello from stdin', 'utf-8').toString('base64'),
    });
    expect(res.stdout).toBe('hello from stdin');
    expect(res.code).toBe(0);
  });

  it('resolves with code=-1 and an error message when the binary is not on PATH', async () => {
    // external:false skips the allowlist so we can try a bogus bare name.
    const res = await run('definitely-not-on-path-xyzzy', [], { external: false });
    expect(res.code).toBe(-1);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('rejects a relative cwd', async () => {
    await expect(run(NODE, ['-e', ''], { cwd: 'some/rel/dir' })).rejects.toThrow(
      /absolute/,
    );
  });

  it('rejects a cwd containing control characters', async () => {
    await expect(run(NODE, ['-e', ''], { cwd: '/tmp/ab\ncd' })).rejects.toThrow(
      /control characters/,
    );
  });

  it('rejects a cwd starting with "-"', async () => {
    // Would otherwise look like a flag to many CLIs when the daemon
    // passes it through via spawn.
    await expect(run(NODE, ['-e', ''], { cwd: '-oops' })).rejects.toThrow(/"-"/);
  });

  it('rejects an empty-string cwd', async () => {
    await expect(run(NODE, ['-e', ''], { cwd: '' })).rejects.toThrow(/non-empty/);
  });

  it('allows cwd=undefined (means "daemon default")', async () => {
    // No throw; runs happily wherever the daemon is.
    const res = await run(NODE, ['-e', 'process.stdout.write("ok")']);
    expect(res.stdout).toBe('ok');
  });

  it('honours an absolute cwd and runs the child in it', async () => {
    const res = await run(NODE, ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: TMP,
    });
    // fs.realpathSync strips symlinks (macOS /tmp → /private/tmp);
    // without this the assertion flakes on darwin CI.
    expect(res.stdout).toBe(fs.realpathSync(TMP));
  });
});

describe('run — external allowlist', () => {
  it('rejects binaries missing from the run allowlist when external=true', async () => {
    // `node` is on the stream allowlist but NOT the (tighter) run
    // allowlist. The run allowlist is intentionally narrower:
    // { git, claude, cat }. Anything else surfaces as a throw.
    await expect(run('node', ['-e', ''], { external: true })).rejects.toThrow(
      /not in run allowlist/,
    );
  });

  it('rejects binaries with path separators', async () => {
    await expect(run('/usr/bin/git', ['--version'], { external: true })).rejects.toThrow(
      /bare name/,
    );
  });

  it('rejects binaries with control characters', async () => {
    await expect(run('git\nrm', [], { external: true })).rejects.toThrow(
      /control characters/,
    );
  });

  it('rejects an empty-string binary', async () => {
    await expect(run('', [], { external: true })).rejects.toThrow(/non-empty/);
  });

  it('accepts allowlisted run binaries', async () => {
    // `git --version` exists everywhere git is installed; node is
    // always present on CI. Use git for the positive test.
    const res = await run('git', ['--version'], { external: true });
    expect(res.stdout).toMatch(/^git version/);
    expect(res.code).toBe(0);
  });
});

describe('streamSpawn — allowlist + lifecycle', () => {
  it('rejects binaries outside the stream allowlist', () => {
    expect(() =>
      streamSpawn(
        's1',
        'rm',
        ['-rf', '/'],
        { keepStdinOpen: false },
        { onData: () => {}, onClose: () => {} },
      ),
    ).toThrow(/not in stream_spawn allowlist/);
  });

  it('rejects a second spawn with the same sessionId', () => {
    // Hold a long-running child so the first session is still registered.
    streamSpawn(
      'sess-dup',
      NODE,
      ['-e', 'setTimeout(()=>{}, 10000)'],
      { keepStdinOpen: true },
      { onData: () => {}, onClose: () => {} },
    );
    try {
      expect(() =>
        streamSpawn(
          'sess-dup',
          NODE,
          ['-e', ''],
          { keepStdinOpen: false },
          { onData: () => {}, onClose: () => {} },
        ),
      ).toThrow(/already exists/);
    } finally {
      killSession('sess-dup');
    }
  });

  it('emits onData and onClose for a one-shot run', async () => {
    let data = '';
    let exitCode: number | null = null;
    const done = new Promise<void>((resolve) => {
      streamSpawn(
        'sess-1',
        NODE,
        ['-e', 'process.stdout.write("hello")'],
        { keepStdinOpen: false },
        {
          onData: (_id, buf) => (data += buf.toString('utf-8')),
          onClose: (_id, code) => {
            exitCode = code;
            resolve();
          },
        },
      );
    });
    await done;
    expect(data).toBe('hello');
    expect(exitCode).toBe(0);
  });

  it('emits onStderr separately from stdout', async () => {
    let err = '';
    let exitCode: number | null = null;
    const done = new Promise<void>((resolve) => {
      streamSpawn(
        'sess-err',
        NODE,
        ['-e', 'process.stderr.write("bad"); process.exit(1)'],
        { keepStdinOpen: false },
        {
          onData: () => {},
          onStderr: (_id, buf) => (err += buf.toString('utf-8')),
          onClose: (_id, code) => {
            exitCode = code;
            resolve();
          },
        },
      );
    });
    await done;
    expect(err).toBe('bad');
    expect(exitCode).toBe(1);
  });

  it('writes initialStdinBase64 and exits after keepStdinOpen=false', async () => {
    let stdout = '';
    const done = new Promise<void>((resolve) => {
      streamSpawn(
        'sess-seed',
        NODE,
        [
          '-e',
          'let buf=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",(c)=>buf+=c); process.stdin.on("end",()=>process.stdout.write(buf));',
        ],
        {
          keepStdinOpen: false,
          initialStdinBase64: Buffer.from('seed-bytes').toString('base64'),
        },
        {
          onData: (_id, buf) => (stdout += buf.toString('utf-8')),
          onClose: () => resolve(),
        },
      );
    });
    await done;
    expect(stdout).toBe('seed-bytes');
  });

  it('surfaces spawn errors as an stderr chunk + exit code 1', async () => {
    // Bypass the allowlist so we can aim at a non-existent binary. We
    // still exercise the on('error') path that followups exit(1) +
    // surface the error as stderr.
    let err = '';
    let exitCode: number | null = null;
    const done = new Promise<void>((resolve) => {
      streamSpawn(
        'sess-badbin',
        'claude', // on the stream allowlist
        ['--help'],
        {
          keepStdinOpen: false,
          // Use a cwd that doesn't exist — Node's spawn raises ENOENT
          // via the 'error' event before the child ever starts.
          cwd: path.join(TMP, 'does', 'not', 'exist'),
        },
        {
          onData: () => {},
          onStderr: (_id, buf) => (err += buf.toString('utf-8')),
          onClose: (_id, code) => {
            exitCode = code;
            resolve();
          },
        },
      );
    });
    await done;
    expect(exitCode).toBe(1);
    expect(err.length).toBeGreaterThan(0);
  });

  it('rejects a stream spawn with a relative cwd', () => {
    expect(() =>
      streamSpawn(
        's-bad-cwd',
        NODE,
        ['-e', ''],
        { cwd: 'relative/dir', keepStdinOpen: false },
        { onData: () => {}, onClose: () => {} },
      ),
    ).toThrow(/absolute/);
  });
});

describe('session management — list/write/close/kill', () => {
  it('listActiveSessions reports pid + startedAt for running children', async () => {
    streamSpawn(
      'alive-1',
      NODE,
      ['-e', 'setTimeout(()=>{}, 10000)'],
      { keepStdinOpen: true },
      { onData: () => {}, onClose: () => {} },
    );
    const active = listActiveSessions();
    expect(active.map((s) => s.sessionId)).toContain('alive-1');
    const row = active.find((s) => s.sessionId === 'alive-1')!;
    expect(row.pid).toBeGreaterThan(0);
    expect(row.startedAt).toBeLessThanOrEqual(Date.now());
    killSession('alive-1');
  });

  it('killSession terminates a running child and emits onClose', async () => {
    let exitCode: number | null = null;
    const done = new Promise<void>((resolve) => {
      streamSpawn(
        'kill-me',
        NODE,
        ['-e', 'setTimeout(()=>{}, 30000)'],
        { keepStdinOpen: true },
        {
          onData: () => {},
          onClose: (_id, code) => {
            exitCode = code;
            resolve();
          },
        },
      );
    });
    killSession('kill-me');
    await done;
    // SIGTERM exit code: null on macOS/Linux → normalized to 0 by the
    // executor, unless node propagates 143 (128+15). Accept either.
    expect(exitCode === 0 || exitCode === 143).toBe(true);
    expect(listActiveSessions().map((s) => s.sessionId)).not.toContain('kill-me');
  });

  it('killSession is a no-op for an unknown session', () => {
    expect(() => killSession('no-such-session')).not.toThrow();
  });

  it('writeSession pushes bytes into an interactive session', async () => {
    let stdout = '';
    const done = new Promise<void>((resolve) => {
      streamSpawn(
        'io-1',
        NODE,
        [
          '-e',
          'process.stdin.setEncoding("utf8"); process.stdin.on("data",(c)=>{ process.stdout.write("echo:"+c); process.exit(0); });',
        ],
        { keepStdinOpen: true },
        {
          onData: (_id, buf) => (stdout += buf.toString('utf-8')),
          onClose: () => resolve(),
        },
      );
    });
    writeSession('io-1', Buffer.from('ping'));
    await done;
    expect(stdout).toBe('echo:ping');
  });

  it('writeSession is a no-op for an unknown session', () => {
    expect(() => writeSession('none', Buffer.from('x'))).not.toThrow();
  });

  it('closeStreamInput ends stdin so the child exits cleanly', async () => {
    let stdout = '';
    let exitCode: number | null = null;
    const done = new Promise<void>((resolve) => {
      streamSpawn(
        'close-1',
        NODE,
        [
          '-e',
          'let buf=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",(c)=>buf+=c); process.stdin.on("end",()=>{ process.stdout.write("saw:"+buf); process.exit(0); });',
        ],
        { keepStdinOpen: true },
        {
          onData: (_id, buf) => (stdout += buf.toString('utf-8')),
          onClose: (_id, code) => {
            exitCode = code;
            resolve();
          },
        },
      );
    });
    writeSession('close-1', Buffer.from('part1'));
    closeStreamInput('close-1');
    await done;
    expect(stdout).toBe('saw:part1');
    expect(exitCode).toBe(0);
  });

  it('closeStreamInput is a no-op for an unknown session', () => {
    expect(() => closeStreamInput('none')).not.toThrow();
  });

  it('shutdownAllSessions kills every live session and empties the map', async () => {
    const closes = [
      new Promise<void>((resolve) => {
        streamSpawn(
          'b-1',
          NODE,
          ['-e', 'setTimeout(()=>{}, 30000)'],
          { keepStdinOpen: true },
          { onData: () => {}, onClose: () => resolve() },
        );
      }),
      new Promise<void>((resolve) => {
        streamSpawn(
          'b-2',
          NODE,
          ['-e', 'setTimeout(()=>{}, 30000)'],
          { keepStdinOpen: true },
          { onData: () => {}, onClose: () => resolve() },
        );
      }),
    ];
    expect(listActiveSessions().length).toBe(2);
    shutdownAllSessions();
    expect(listActiveSessions().length).toBe(0);
    await Promise.all(closes);
  });
});

describe('setChildEnv', () => {
  it('injects env vars into spawned children', async () => {
    setChildEnv({ FASTOWL_TEST_VAR: 'injected' });
    const res = await run(NODE, [
      '-e',
      'process.stdout.write(process.env.FASTOWL_TEST_VAR ?? "missing")',
    ]);
    expect(res.stdout).toBe('injected');
  });

  it('unsets env vars when the override value is undefined', async () => {
    process.env.FASTOWL_TEST_UNSET_VAR = 'from-parent';
    setChildEnv({ FASTOWL_TEST_UNSET_VAR: undefined });
    const res = await run(NODE, [
      '-e',
      'process.stdout.write(process.env.FASTOWL_TEST_UNSET_VAR ?? "missing")',
    ]);
    expect(res.stdout).toBe('missing');
    delete process.env.FASTOWL_TEST_UNSET_VAR;
  });

  it('always scrubs FASTOWL_AUTH_TOKEN from the child env', async () => {
    // Defense-in-depth: the daemon's proxy is the only auth surface
    // children should have. A stray shell token on the daemon host
    // must not leak through.
    process.env.FASTOWL_AUTH_TOKEN = 'stray-token';
    const res = await run(NODE, [
      '-e',
      'process.stdout.write(process.env.FASTOWL_AUTH_TOKEN ?? "missing")',
    ]);
    expect(res.stdout).toBe('missing');
    delete process.env.FASTOWL_AUTH_TOKEN;
  });
});
