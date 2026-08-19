// Telling a broken runner apart from a broken PR.
//
// Every job shape below is modelled on the real one behind
// PostHog/posthog#85338: trunk failed the PR on `Playwright tests pass`, and the
// job it linked had died in "Apply postgres and clickhouse migrations and setup
// dev" with "failed to bind host port for 0.0.0.0:50052 … address already in
// use". No test ran, the PR was green on its own branch, and the queue was about
// to spend a cloud fix run on it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { githubService } from '../services/github.js';
import {
  _resetExternalQueueFailures,
  classifyExternalQueueFailure,
} from '../services/externalQueueFailure.js';

const JOB_URL = 'https://github.com/PostHog/posthog/actions/runs/32250916189/job/96064408804';
const RUN_URL = 'https://github.com/PostHog/posthog/actions/runs/32250916189';

const step = (name: string, conclusion: string) => ({ name, conclusion });

const job = (name: string, steps: Array<{ name: string; conclusion: string }>) => ({
  id: 96064408804,
  name,
  conclusion: 'failure',
  steps,
});

describe('classifyExternalQueueFailure', () => {
  let getJob: ReturnType<typeof vi.spyOn>;
  let listJobs: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetExternalQueueFailures();
    getJob = vi.spyOn(githubService, 'getWorkflowJob');
    listJobs = vi.spyOn(githubService, 'listWorkflowRunJobs');
  });
  afterEach(() => vi.restoreAllMocks());

  it('calls the real #85338 shape infrastructure', async () => {
    getJob.mockResolvedValue(
      job('Playwright E2E tests', [
        step('Set up job', 'success'),
        step('Apply postgres and clickhouse migrations and setup dev', 'failure'),
      ])
    );
    const verdict = await classifyExternalQueueFailure('ws', 'PostHog', 'posthog', JOB_URL);
    expect(verdict).toEqual({
      kind: 'infrastructure',
      detail: 'the "Apply postgres and clickhouse migrations and setup dev" step failed',
    });
    expect(getJob).toHaveBeenCalledWith('ws', 'PostHog', 'posthog', 96064408804);
  });

  it.each([
    ['Set up job'],
    ['Checkout code'],
    ['Install dependencies'],
    ['Start docker compose services'],
    ['Restore npm cache'],
    ['Upload artifact'],
    ['Wait for ClickHouse'],
    ['Log in to the container registry'],
  ])('recognises %s as infrastructure', async (name) => {
    getJob.mockResolvedValue(job('CI', [step(name, 'failure')]));
    expect((await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL))?.kind).toBe(
      'infrastructure'
    );
  });

  it.each([
    ['Run Playwright tests'],
    ['pytest posthog/'],
    ['Jest unit tests'],
    ['Check for type errors'],
  ])('leaves %s alone — that failure belongs to the PR', async (name) => {
    getJob.mockResolvedValue(job('CI', [step(name, 'failure')]));
    expect((await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL))?.kind).toBe('unknown');
  });

  it('refuses to call a job infrastructure when ONE real test also failed', async () => {
    getJob.mockResolvedValue(
      job('CI', [step('Install dependencies', 'failure'), step('Run tests', 'failure')])
    );
    expect((await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL))?.kind).toBe('unknown');
  });

  it('treats a job that failed with no failing step as a dead runner', async () => {
    getJob.mockResolvedValue(job('Playwright E2E tests', [step('Set up job', 'success')]));
    const verdict = await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL);
    expect(verdict).toEqual({
      kind: 'infrastructure',
      detail: 'the "Playwright E2E tests" job failed without any step failing',
    });
  });

  it('says nothing about a job that did not fail', async () => {
    getJob.mockResolvedValue({ id: 1, name: 'CI', conclusion: 'cancelled', steps: [] });
    expect(await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL)).toBeNull();
  });

  it('judges every failing job of a run-level link, and one real failure settles it', async () => {
    listJobs.mockResolvedValue({
      jobs: [
        { ...job('setup', [step('Set up job', 'failure')]) },
        { id: 2, name: 'green', conclusion: 'success', steps: [] },
      ],
    });
    expect((await classifyExternalQueueFailure('ws', 'o', 'r', RUN_URL))?.kind).toBe(
      'infrastructure'
    );

    _resetExternalQueueFailures();
    listJobs.mockResolvedValue({
      jobs: [
        { ...job('setup', [step('Set up job', 'failure')]) },
        { ...job('tests', [step('Run tests', 'failure')]) },
      ],
    });
    expect((await classifyExternalQueueFailure('ws', 'o', 'r', RUN_URL))?.kind).toBe('unknown');
  });

  it('asks GitHub once per job, however often the PR is re-evaluated', async () => {
    getJob.mockResolvedValue(job('CI', [step('Set up job', 'failure')]));
    await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL);
    await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL);
    await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL);
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no link at all', undefined],
    ['a link to something else', 'https://app.trunk.io/posthog-inc/merge-queue/abc/85338'],
  ])('cannot tell from %s, and says so rather than guessing', async (_name, url) => {
    expect(await classifyExternalQueueFailure('ws', 'o', 'r', url)).toBeNull();
    expect(getJob).not.toHaveBeenCalled();
  });

  it('reads a refusal from GitHub as "cannot tell", never as infrastructure', async () => {
    getJob.mockRejectedValue(new Error('Resource not accessible by integration'));
    expect(await classifyExternalQueueFailure('ws', 'o', 'r', JOB_URL)).toBeNull();
  });
});
