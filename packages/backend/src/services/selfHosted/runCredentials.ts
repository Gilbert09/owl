import { and, eq, sql } from 'drizzle-orm';
import { readCloudTaskMeta } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable } from '../../db/schema.js';
import { githubService } from '../github.js';
import { getSelfHostedCredentials } from './credentials.js';

/**
 * Serving an adopted run's credentials back to the host that lost them.
 *
 * # Why the host asks instead of being told
 *
 * A fleet host holds credentials only in memory (fleet spec §12.4), so a fleetd
 * restart loses them and the surviving microVM cannot authenticate anything.
 * The original repair was a push: the backend polls, notices `adopted`, and
 * POSTs them back. That puts the obligation on the party that has to NOTICE,
 * and on 2026-08-05 that chain broke three times in half an hour — a once-per-
 * task guard suppressed one run's second adoption, and a fleetd pegged at 209%
 * CPU made the polls that would have re-credentialed two others time out first.
 * All three ran blind for eighteen minutes and were reported as
 * "guest did not reconnect".
 *
 * The host knows, at a definite moment, that it has lost them. So it asks.
 *
 * # The authorization, which is the whole security story
 *
 * This hands out a workspace's GitHub token and Anthropic key to a caller
 * holding only `FLEET_REPORT_TOKEN` — a deployment-wide secret shared by every
 * host. Without a check, that token would be enough to name any run id and
 * collect the credentials behind it.
 *
 * So the answer is bounded to what the caller already legitimately had: a run
 * this backend itself dispatched, TO THIS HOST, that is still in flight. Then a
 * host can only ever re-obtain credentials it was already holding a moment ago,
 * which makes the pull no more powerful than the push it replaces.
 *
 * `host` is taken from the body rather than the source address on purpose:
 * reports arrive NAT'd (see `FleetHostReport.apiEndpoint`), so the source
 * address is not an identity and treating it as one would be a check that looks
 * like it works.
 */

export interface FleetRunCredentials {
  githubToken: string;
  anthropicKey?: string;
  repo?: string;
}

/** Why a request was refused, for the route to turn into a status code. */
export type RunCredentialsDenial =
  | 'unknown_run'
  | 'wrong_host'
  | 'run_not_live'
  | 'credentials_unavailable';

export type RunCredentialsResult =
  | { ok: true; credentials: FleetRunCredentials }
  | { ok: false; reason: RunCredentialsDenial };

/**
 * The task statuses for which a run is still legitimately holding credentials.
 *
 * A terminal task has nothing left to authenticate, so serving it credentials
 * would be handing out secrets for work that is over — the difference between
 * "give me back what I was holding" and "give me a key".
 */
const LIVE_TASK_STATUSES = ['pending', 'queued', 'in_progress'] as const;

/**
 * Columns this read needs. Explicit because `tasks` carries `transcript`, which
 * is megabytes of conversation log and would be shipped on every credential
 * fetch — the exact `SELECT *` regression the egress rules in CLAUDE.md exist
 * to prevent.
 */
const RUN_CREDENTIAL_COLUMNS = {
  id: tasksTable.id,
  workspaceId: tasksTable.workspaceId,
  status: tasksTable.status,
  metadata: tasksTable.metadata,
} as const;

export async function resolveRunCredentials(
  host: string,
  runId: string,
): Promise<RunCredentialsResult> {
  const rows = await getDbClient()
    .select(RUN_CREDENTIAL_COLUMNS)
    .from(tasksTable)
    .where(
      and(
        sql`${tasksTable.metadata} -> 'cloudTask' ->> 'remoteTaskId' = ${runId}`,
        eq(sql`${tasksTable.metadata} -> 'cloudTask' ->> 'provider'`, 'selfhosted'),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown_run' };

  const cloud = readCloudTaskMeta({ metadata: row.metadata as Record<string, unknown> | null });
  const extra = (cloud?.extra ?? {}) as { host?: string; repo?: string };

  // The host must be the one this run was dispatched to. A run with no recorded
  // host is refused rather than allowed: an unknown host is not a match, and
  // defaulting to "anyone" here is precisely the hole this check exists to
  // close.
  if (!extra.host || extra.host !== host) return { ok: false, reason: 'wrong_host' };

  if (!(LIVE_TASK_STATUSES as readonly string[]).includes(row.status)) {
    return { ok: false, reason: 'run_not_live' };
  }

  const githubToken = githubService.getAccessToken(row.workspaceId);
  const creds = await getSelfHostedCredentials(row.workspaceId);
  // No GitHub token means the workspace disconnected GitHub mid-run. Refusing
  // is right: an answer with an empty token would close the proxy's
  // credentials-ready gate on nothing, turning its wait into an immediate
  // failure — worse than either waiting or failing honestly.
  if (!githubToken) return { ok: false, reason: 'credentials_unavailable' };

  return {
    ok: true,
    credentials: {
      githubToken,
      ...(creds?.claudeToken ? { anthropicKey: creds.claudeToken } : {}),
      ...(extra.repo ? { repo: extra.repo } : {}),
    },
  };
}
