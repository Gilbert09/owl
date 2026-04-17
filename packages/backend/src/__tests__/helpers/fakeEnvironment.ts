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

  const originalSpawn = environmentService.spawnInteractive.bind(environmentService);
  const originalKill = environmentService.killSession.bind(environmentService);

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
        // Find a fixture that matches the command
        let output = '';
        for (const [pattern, fixture] of Object.entries(outputs)) {
          if (command.includes(pattern)) {
            output = fixture;
            break;
          }
        }

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

  (environmentService as any).spawnInteractive = spawnSpy;
  (environmentService as any).killSession = killSpy;

  return {
    commands,
    restore: () => {
      (environmentService as any).spawnInteractive = originalSpawn;
      (environmentService as any).killSession = originalKill;
      environmentService.removeAllListeners('session:data');
      environmentService.removeAllListeners('session:close');
    },
  };
}
