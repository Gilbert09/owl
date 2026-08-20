// The provider's submit COMMAND, remembered per repo.
//
// trunk keeps ONE comment per PR and rewrites its body through the lifecycle,
// so the instruction that names the command ("… or comment `/trunk merge`
// below") is present only while the PR is UNSUBMITTED. The moment trunk accepts
// the PR the body becomes a status line, and most of its failure bodies carry no
// command either. Reading the command off the PR alone therefore fails on
// exactly the two paths that need it most — a resubmit after an ejection, and
// any re-evaluation of a PR the queue already holds — and Talyn then reported
// "no way to submit the PR automatically" on a perfectly healthy PR that trunk
// was sitting on (PostHog/posthog#84433, 2026-08-19).
//
// The command is repo CONFIGURATION, not PR state, so it is remembered per repo
// from any PR where trunk did offer it: the webhook feed and every comment list
// the queue already fetches keep it warm (see externalQueueState.ts).
//
// **It is PERSISTED, because it is a door and not a cache.** It first shipped as
// a process-local Map, whose reasoning covered staleness carefully and never
// mentioned process lifetime — the thing that actually breaks it. Every deploy
// wipes the memo, and this repo deploys on every push to main. A cold memo does
// not fall back to a slower door, it falls back to a WORSE one: on
// PostHog/posthog the command door works (trunk accepts `/trunk merge` from
// talyn-app[bot]) while the submit LABEL is refused for the same App and deleted
// again, so #82679 fell past the empty memo onto the label and looped 61 times
// in an hour. The in-process Map is kept in front of the table as a read cache
// so the hot path stays synchronous.
//
// No expiry. The memo only ever ADDS a door trunk itself offered in this repo, a
// stale one costs a single comment trunk ignores, and a missing one costs a
// false block on a green PR. One row per repo, so it cannot grow with traffic.
//
// Its own module rather than a corner of repoMergeGate.ts: the state cache feeds
// it, and routing that feed through the gate module would make every test that
// mocks the gate silently lose the memory.

import { sql } from 'drizzle-orm';
import type { ExternalQueueInstruction, ExternalQueueProvider } from '@talyn/shared';
import { getPoolDbClient } from '../db/client.js';
import { externalQueueSubmitRoutes } from '../db/schema.js';

const submitRoutes = new Map<string, ExternalQueueInstruction>();

function routeKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Remember a command the provider offered on one of this repo's PRs.
 *
 * Fire-and-forget on the DB: the in-memory write is what this call's caller
 * depends on, and a failed persist only costs the memory it already has until
 * the next comment re-teaches it. Skips the write entirely when the command is
 * unchanged, so the routine comment traffic that keeps this warm doesn't turn
 * into a write per comment.
 */
export function noteExternalQueueSubmitRoute(
  owner: string,
  repo: string,
  instruction: ExternalQueueInstruction
): void {
  const key = routeKey(owner, repo);
  const known = submitRoutes.get(key);
  submitRoutes.set(key, instruction);
  if (known && known.command === instruction.command && known.provider === instruction.provider) {
    return;
  }
  // Nothing about persistence may affect the door. The whole call is guarded,
  // not just the promise: `getPoolDbClient()` throws SYNCHRONOUSLY when there is
  // no pool, and an unguarded throw here would propagate up through the comment
  // read that feeds this and take out the very door it is trying to remember.
  try {
    void getPoolDbClient()
      .insert(externalQueueSubmitRoutes)
      .values({
        repoFullName: key,
        provider: instruction.provider,
        command: instruction.command,
      })
      .onConflictDoUpdate({
        target: externalQueueSubmitRoutes.repoFullName,
        set: {
          provider: sql`excluded.provider`,
          command: sql`excluded.command`,
          updatedAt: sql`now()`,
        },
      })
      .catch(warnPersistFailed(key));
  } catch (err) {
    warnPersistFailed(key)(err);
  }
}

function warnPersistFailed(key: string): (err: unknown) => void {
  return (err) =>
    console.warn(
      `[externalQueueSubmitRoute] failed to persist the submit command for ${key}:`,
      err instanceof Error ? err.message : err
    );
}

/** The command this repo's provider accepts, learned from an earlier PR. */
export function rememberedExternalQueueSubmitRoute(
  owner: string,
  repo: string
): ExternalQueueInstruction | null {
  return submitRoutes.get(routeKey(owner, repo)) ?? null;
}

/**
 * Load every persisted route into memory at boot, so the first evaluation after
 * a deploy already knows the door. One query, one row per repo — the whole point
 * of the table is that this is the state a restart used to throw away.
 */
export async function loadExternalQueueSubmitRoutes(): Promise<number> {
  const rows = await getPoolDbClient()
    .select({
      repoFullName: externalQueueSubmitRoutes.repoFullName,
      provider: externalQueueSubmitRoutes.provider,
      command: externalQueueSubmitRoutes.command,
    })
    .from(externalQueueSubmitRoutes);
  for (const row of rows) {
    submitRoutes.set(row.repoFullName, {
      provider: row.provider as ExternalQueueProvider,
      command: row.command,
    });
  }
  return rows.length;
}

/** Test hook. */
export function _resetSubmitRoutes(): void {
  submitRoutes.clear();
}
