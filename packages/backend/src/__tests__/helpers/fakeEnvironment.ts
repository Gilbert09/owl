import { vi } from 'vitest';
import { environmentService } from '../../services/environment.js';

export interface RecordedCommand {
  environmentId: string;
  sessionId: string;
  command: string;
  cwd?: string;
}

export interface FakeEnvironmentOptions {
  /**
   * Map from command substring → stdout the fake should emit before closing
   * the session. First match wins. Unmatched commands emit no output.
   */
  outputs?: Record<string, string>;
  /** Exit code to send on session close. Defaults to 0. */
  exitCode?: number | null;
}

export interface FakeEnvironmentHandle {
  commands: RecordedCommand[];
  restore: () => void;
}

/**
 * Replace environmentService.spawnInteractive (and related session lifecycle
 * methods) with in-memory fakes. Records every command the subject under
 * test issues, and lets you feed fixture output back.
 *
 * Usage:
 *   const fake = installFakeEnvironment({ outputs: { 'git rev-parse': 'exists\n' } });
 *   try {
 *     await gitService.createTaskBranch('env1', 'task1', 'title');
 *     expect(fake.commands.map(c => c.command)).toContain('git checkout ...');
 *   } finally {
 *     fake.restore();
 *   }
 */
export function installFakeEnvironment(
  opts: FakeEnvironmentOptions = {}
): FakeEnvironmentHandle {
  const commands: RecordedCommand[] = [];
  const { outputs = {}, exitCode = 0 } = opts;

  function resolveOutput(command: string): string {
    for (const [pattern, fixture] of Object.entries(outputs)) {
      if (command.includes(pattern)) return fixture;
    }
    return '';
  }

  const originalSpawn = environmentService.spawnInteractive.bind(environmentService);
  const originalKill = environmentService.killSession.bind(environmentService);
  const originalExec = environmentService.exec.bind(environmentService);

  const execSpy = vi.fn(
    async (
      environmentId: string,
      command: string,
      options: { cwd?: string } = {}
    ) => {
      commands.push({ environmentId, sessionId: '(exec)', command, cwd: options.cwd });
      return {
        stdout: resolveOutput(command),
        stderr: '',
        code: exitCode ?? 0,
      };
    }
  );

  const spawnSpy = vi.fn(
    async (
      environmentId: string,
      sessionId: string,
      command: string,
      options: { cwd?: string; rows?: number; cols?: number } = {}
    ) => {
      commands.push({
        environmentId,
        sessionId,
        command,
        cwd: options.cwd,
      });

      // Fire output + close events asynchronously so the subject can
      // register listeners before they arrive (mirrors real PTY timing).
      queueMicrotask(() => {
        const output = resolveOutput(command);
        if (output) {
          environmentService.emit('session:data', sessionId, Buffer.from(output));
        }
        environmentService.emit('session:close', sessionId, exitCode);
      });
    }
  );

  const killSpy = vi.fn((_sessionId: string) => {
    // no-op for fake
  });

  // Cast the service to a mutable shape so we can swap bound methods in tests.
  const svc = environmentService as unknown as {
    spawnInteractive: typeof environmentService.spawnInteractive;
    killSession: typeof environmentService.killSession;
    exec: typeof environmentService.exec;
  };
  svc.spawnInteractive = spawnSpy;
  svc.killSession = killSpy;
  svc.exec = execSpy;

  return {
    commands,
    restore: () => {
      svc.spawnInteractive = originalSpawn;
      svc.killSession = originalKill;
      svc.exec = originalExec;
      environmentService.removeAllListeners('session:data');
      environmentService.removeAllListeners('session:close');
    },
  };
}
