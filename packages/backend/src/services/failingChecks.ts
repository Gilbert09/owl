import type { FailingChecksReading, PRMergeableSummary } from '@talyn/shared';

import { githubService } from './github.js';

/**
 * The failing check names to put in a fix run's prompt, or undefined.
 *
 * The cached summary carries a COUNT and a hash of the failing set, never the
 * names — that row ships on every poll tick, so the names are deliberately not
 * persisted (see the DB-egress rules in CLAUDE.md). A dispatch that wants to
 * point an agent at a specific red job therefore has to read them live, which
 * is affordable precisely because dispatches are rare.
 *
 * Two ways to get undefined, both meaning "we didn't look" rather than "nothing
 * is failing": the summary already says the count is zero (so the call would be
 * wasted), or the read failed. Never throws — a sharper prompt must never be
 * able to stop a fix run from starting.
 */
export async function readFailingChecks(
  workspaceId: string,
  owner: string,
  repo: string,
  number: number,
  summary: PRMergeableSummary
): Promise<FailingChecksReading | undefined> {
  if ((summary.checks?.failed ?? 0) === 0) return undefined;
  const reading = await githubService.listFailingCheckNames(workspaceId, owner, repo, number);
  return reading && reading.names.length > 0 ? reading : undefined;
}
