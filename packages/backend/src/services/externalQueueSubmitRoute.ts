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
// No expiry. The memo only ever ADDS a door trunk itself offered in this repo, a
// stale one costs a single comment trunk ignores, and a missing one costs a
// false block on a green PR. One entry per repo, so it cannot grow with traffic.
//
// Its own module rather than a corner of repoMergeGate.ts: the state cache feeds
// it, and routing that feed through the gate module would make every test that
// mocks the gate silently lose the memory.

import type { ExternalQueueInstruction } from '@talyn/shared';

const submitRoutes = new Map<string, ExternalQueueInstruction>();

function routeKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** Remember a command the provider offered on one of this repo's PRs. */
export function noteExternalQueueSubmitRoute(
  owner: string,
  repo: string,
  instruction: ExternalQueueInstruction
): void {
  submitRoutes.set(routeKey(owner, repo), instruction);
}

/** The command this repo's provider accepts, learned from an earlier PR. */
export function rememberedExternalQueueSubmitRoute(
  owner: string,
  repo: string
): ExternalQueueInstruction | null {
  return submitRoutes.get(routeKey(owner, repo)) ?? null;
}

/** Test hook. */
export function _resetSubmitRoutes(): void {
  submitRoutes.clear();
}
