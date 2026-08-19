// Why did the external merge queue's own test run fail?
//
// The queue tests the PR MERGED WITH the base — a state that exists only inside
// the queue — so a failure there is normally real, and exactly what Talyn's
// `queue_failure` fix runs are for. But some of those failures never reached a
// test at all: the runner couldn't bind a port, start a container, run the
// migrations, install a dependency. On posthog/posthog trunk sent a PR back with
//
//     ⚠️ The required check `Playwright tests pass` (Failure) has failed.
//
// whose job had died in "Apply postgres and clickhouse migrations and setup dev"
// with "failed to bind host port for 0.0.0.0:50052 … address already in use"
// (2026-08-19). The PR's own checks were green; nothing about it was wrong. Left
// unclassified, that shape costs a cloud fix run (which cannot fix a runner) and
// then blocks the PR as if its author had broken something.
//
// The distinction is only visible in the JOB's step results, so that is what
// this reads. It is deliberately one-sided: anything it cannot positively
// recognise as infrastructure comes back `unknown`, which is the behaviour that
// existed before this module — the queue treats it as a real failure.

import { githubService } from './github.js';
import type { ExternalQueueFailure } from './mergeQueue/types.js';

/**
 * Steps that run BEFORE (or after) the work a PR can influence: environment
 * setup, service startup, dependency and artifact plumbing. A failure in one of
 * these is a property of the runner, not of the diff.
 *
 * Matched against the failing steps of the job the provider blamed. The list
 * grew from the real posthog/posthog job names; add to it when a new
 * infrastructure shape shows up, never to cover a test step that happens to be
 * flaky (a flaky TEST is still the PR's problem to see).
 */
const INFRA_STEP_PATTERNS: RegExp[] = [
  /^set ?up /i,
  /^complete job$/i,
  /^post /i,
  /checkout/i,
  /install/i,
  /migrat/i,
  /docker|compose|container|registry/i,
  /cache/i,
  /artifact/i,
  /\b(start|launch|boot)\b.*\b(service|server|stack|db|database|cluster)/i,
  /wait[- ]?for/i,
  /login|authenticat|credential/i,
];

/**
 * Cached per job URL. A finished job's steps never change, so this is a pure
 * memo — it exists so a PR re-evaluated every few minutes while it waits costs
 * one GitHub call per failure, not one per evaluation. Bounded by the same
 * retention as the state cache: entries stop being asked for once the PR moves
 * on, and this only bounds memory, never freshness.
 */
const verdicts = new Map<string, { value: ExternalQueueFailure; at: number }>();
const RETENTION_MS = 60 * 60_000;

function prune(now: number): void {
  for (const [key, v] of verdicts) {
    if (now - v.at > RETENTION_MS) verdicts.delete(key);
  }
}

/** Test hook — drop every verdict. */
export function _resetExternalQueueFailures(): void {
  verdicts.clear();
}

interface JobShape {
  name: string;
  conclusion: string | null;
  steps?: Array<{ name: string; conclusion: string | null }>;
}

/** `.../actions/runs/<run>[/job/<job>]` — the two link shapes trunk posts. */
function parseFailureUrl(url: string): { runId: number; jobId: number | null } | null {
  const match = url.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  if (!match) return null;
  return { runId: Number(match[1]), jobId: match[2] ? Number(match[2]) : null };
}

function isInfraStep(name: string): boolean {
  return INFRA_STEP_PATTERNS.some((re) => re.test(name));
}

/**
 * Read one job's verdict. Infrastructure when EVERY failing step is a setup
 * step, or when the job failed without any step failing at all (the runner died
 * before, or between, steps). One dissenting step — a real test — is enough to
 * make the whole thing `unknown`.
 */
function classifyJob(job: JobShape): ExternalQueueFailure | null {
  if (job.conclusion !== 'failure') return null;
  const failed = (job.steps ?? []).filter(
    (s) => s.conclusion === 'failure' || s.conclusion === 'timed_out'
  );
  if (failed.length === 0) {
    return {
      kind: 'infrastructure',
      detail: `the "${job.name}" job failed without any step failing`,
    };
  }
  if (!failed.every((s) => isInfraStep(s.name))) return { kind: 'unknown', detail: '' };
  const names = failed.map((s) => `"${s.name}"`).join(', ');
  return { kind: 'infrastructure', detail: `the ${names} step failed` };
}

/**
 * Why the queue's run failed, or null when it can't be told (no link, GitHub
 * refused, nothing recognisable). Null and `unknown` mean the same thing to the
 * caller — treat the failure as real — and are distinct only so the timeline can
 * say which happened.
 */
export async function classifyExternalQueueFailure(
  workspaceId: string,
  owner: string,
  repo: string,
  failureUrl: string | undefined
): Promise<ExternalQueueFailure | null> {
  if (!failureUrl) return null;
  const cached = verdicts.get(failureUrl);
  if (cached) return cached.value;

  const target = parseFailureUrl(failureUrl);
  if (!target) return null;

  let verdict: ExternalQueueFailure | null = null;
  try {
    if (target.jobId !== null) {
      verdict = classifyJob(await githubService.getWorkflowJob(workspaceId, owner, repo, target.jobId));
    } else {
      // Run-level link: the failing jobs of that run are the ones to judge, and
      // one non-infrastructure failure among them settles it.
      const { jobs } = await githubService.listWorkflowRunJobs(
        workspaceId,
        owner,
        repo,
        target.runId
      );
      const judged = jobs.map(classifyJob).filter((v): v is ExternalQueueFailure => v !== null);
      if (judged.length > 0) {
        verdict = judged.every((v) => v.kind === 'infrastructure')
          ? judged.find((v) => v.kind === 'infrastructure')!
          : { kind: 'unknown', detail: '' };
      }
    }
  } catch (err) {
    console.warn(
      `[externalQueueFailure] couldn't read ${failureUrl}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
  if (!verdict) return null;
  const now = Date.now();
  verdicts.set(failureUrl, { value: verdict, at: now });
  prune(now);
  return verdict;
}
