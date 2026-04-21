import { daemonRegistry } from './daemonRegistry.js';
import { environmentService } from './environment.js';

/**
 * Forced model for every fan-out call. These are background generation
 * jobs (titles, commit messages, metadata) — Haiku is fast and cheap
 * and produces fine results. Hard-coding it keeps cost predictable
 * and avoids whatever Sonnet/Opus default the user's CLI might be on.
 */
const HAIKU_MODEL = 'claude-haiku-4-5';

/**
 * Pick a daemon-backed environment to run a short LLM call on.
 *
 *   1. The task's assigned env, if it's connected.
 *   2. Otherwise, any connected daemon — usually the user's local
 *      "This Mac" daemon, which is always around once they've paired.
 *
 * Returns null when no daemon is reachable; callers fall back to a
 * heuristic (e.g. first-N-chars of the prompt) so the feature never
 * blocks task creation.
 */
export function pickGenerationEnv(preferredEnvId?: string | null): string | null {
  if (preferredEnvId && daemonRegistry.isConnected(preferredEnvId)) {
    return preferredEnvId;
  }
  const connected = daemonRegistry.listConnected();
  return connected[0] ?? null;
}

/**
 * One-shot `claude --print` invocation on the given env's daemon.
 *
 * Uses the user's existing Claude credentials on the daemon host —
 * Pro/Max subscription, API key, or whatever they've set up for normal
 * `claude` use. No backend secret required.
 *
 * The prompt is passed as a direct argv element — no shell, no
 * escaping. Arbitrary bytes (newlines, quotes, backticks, emoji) flow
 * through unchanged.
 *
 * Throws on non-zero exit so callers can fall back gracefully.
 */
export async function runClaudeCli(envId: string, prompt: string): Promise<string> {
  const result = await environmentService.run(envId, 'claude', [
    '--print',
    '--model',
    HAIKU_MODEL,
    prompt,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `claude CLI failed (exit ${result.code}): ${result.stderr || result.stdout || '(no output)'}`
    );
  }
  return result.stdout.trim();
}
