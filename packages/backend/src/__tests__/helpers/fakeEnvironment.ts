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
 * Replaces `environmentService.exec` / `spawnStreaming` / `killSession`
 * with in-memory fakes. Records every command the subject under test
 * issues and lets you feed canned stdout back.
 *
 * Used by tests that drive the agent lifecycle or the git service
 * without actually spawning processes.
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

  const originalSpawnStreaming =
    environmentService.spawnStreaming.bind(environmentService);
  const originalKill = environmentService.killSession.bind(environmentService);
  const originalCloseInput =
    environmentService.closeStreamInput.bind(environmentService);
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

  const spawnStreamingSpy = vi.fn(
    async (
      environmentId: string,
      sessionId: string,
      binary: string,
      args: string[],
      options: {
        cwd?: string;
        env?: Record<string, string>;
        keepStdinOpen: boolean;
        initialStdin?: Buffer | string;
      }
    ) => {
      // Record a readable command string so test assertions can
      // pattern-match on the intended argv.
      const command = `${binary} ${args.join(' ')}`;
      commands.push({
        environmentId,
        sessionId,
        command,
        cwd: options.cwd,
      });

      // Fire output + close asynchronously so subjects register
      // listeners first (mirrors real subprocess timing).
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

  const closeInputSpy = vi.fn(async (_sessionId: string) => {
    // no-op for fake
  });

  // Cast the service to a mutable shape so we can swap bound methods in tests.
  const svc = environmentService as unknown as {
    spawnStreaming: typeof environmentService.spawnStreaming;
    killSession: typeof environmentService.killSession;
    closeStreamInput: typeof environmentService.closeStreamInput;
    exec: typeof environmentService.exec;
  };
  svc.spawnStreaming = spawnStreamingSpy;
  svc.killSession = killSpy;
  svc.closeStreamInput = closeInputSpy;
  svc.exec = execSpy;

  return {
    commands,
    restore: () => {
      svc.spawnStreaming = originalSpawnStreaming;
      svc.killSession = originalKill;
      svc.closeStreamInput = originalCloseInput;
      svc.exec = originalExec;
      environmentService.removeAllListeners('session:data');
      environmentService.removeAllListeners('session:stderr');
      environmentService.removeAllListeners('session:close');
    },
  };
}
