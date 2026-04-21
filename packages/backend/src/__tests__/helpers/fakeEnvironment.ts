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
   *
   * For `run` (argv) calls the synthesized command string is
   * `${binary} ${args.join(' ')}` — the pattern matches whichever part
   * the test cares about.
   */
  outputs?: Record<string, string>;
  /** Exit code to send on session close. Defaults to 0. */
  exitCode?: number | null;
  /**
   * Optional per-command exit-code overrides. Substring match; first
   * match wins. Useful for scripting branch flows like "rev-parse
   * fails → create via -b" without juggling multiple fakes.
   */
  exitCodes?: Record<string, number>;
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
  const { outputs = {}, exitCode = 0, exitCodes = {} } = opts;

  function resolveOutput(command: string): string {
    for (const [pattern, fixture] of Object.entries(outputs)) {
      if (command.includes(pattern)) return fixture;
    }
    return '';
  }

  function resolveExitCode(command: string): number {
    for (const [pattern, code] of Object.entries(exitCodes)) {
      if (command.includes(pattern)) return code;
    }
    return exitCode ?? 0;
  }

  const originalSpawnStreaming =
    environmentService.spawnStreaming.bind(environmentService);
  const originalKill = environmentService.killSession.bind(environmentService);
  const originalCloseInput =
    environmentService.closeStreamInput.bind(environmentService);
  const originalRun = environmentService.run.bind(environmentService);

  const runSpy = vi.fn(
    async (
      environmentId: string,
      binary: string,
      args: string[],
      options: { cwd?: string; stdinBase64?: string } = {}
    ) => {
      const command = `${binary} ${args.join(' ')}`;
      commands.push({ environmentId, sessionId: '(run)', command, cwd: options.cwd });
      return {
        stdout: resolveOutput(command),
        stderr: '',
        code: resolveExitCode(command),
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
    run: typeof environmentService.run;
  };
  svc.spawnStreaming = spawnStreamingSpy;
  svc.killSession = killSpy;
  svc.closeStreamInput = closeInputSpy;
  svc.run = runSpy;

  return {
    commands,
    restore: () => {
      svc.spawnStreaming = originalSpawnStreaming;
      svc.killSession = originalKill;
      svc.closeStreamInput = originalCloseInput;
      svc.run = originalRun;
      environmentService.removeAllListeners('session:data');
      environmentService.removeAllListeners('session:stderr');
      environmentService.removeAllListeners('session:close');
    },
  };
}
