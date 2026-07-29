// The external-queue state cache: webhook-fed, REST-backstopped.
//
// The contract that matters is the COST one — a merge queue evaluating a group
// every 60s must not list a PR's comments every 60s — so most of this is about
// which calls do and don't reach GitHub, and the staleness policy that decides.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetExternalQueueState,
  noteIssueComment,
  noteIssueComments,
  readExternalQueueState,
} from '../services/externalQueueState.js';
import { externalStateMaxAge } from '../services/mergeQueue/executor.js';
import type { EntrySnapshot } from '../services/mergeQueue/types.js';
import { githubService } from '../services/github.js';

const LINK = '(https://app.trunk.io/posthog-inc/merge-queue/3921a8a3/74552)';
const testing = `\u{1F9EA} Running tests on this pull request - [details]${LINK}.`;
const merged = `\u{1F60E} Merged successfully - [details]${LINK}.`;
const trunk = (body: string) => ({ body, user: { login: 'trunk-io[bot]' } });

describe('externalQueueState', () => {
  let list: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetExternalQueueState();
    list = vi.spyOn(githubService, 'listIssueComments').mockResolvedValue([trunk(testing)]);
  });
  afterEach(() => vi.restoreAllMocks());

  const read = (maxAgeMs = 60_000) =>
    readExternalQueueState('ws', 'PostHog', 'posthog', 74552, maxAgeMs);

  it('serves a webhook-fed observation without calling GitHub', async () => {
    noteIssueComment('PostHog', 'posthog', 74552, trunk(merged));
    expect((await read())?.state).toBe('merged');
    expect(list).not.toHaveBeenCalled();
  });

  it('falls back to one REST read when nothing has been observed', async () => {
    expect((await read())?.state).toBe('testing');
    expect(list).toHaveBeenCalledTimes(1);
    // …and that read is itself cached.
    await read();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the cached observation is older than the caller allows', async () => {
    noteIssueComment('PostHog', 'posthog', 74552, trunk(merged));
    expect((await read(0))?.state).toBe('testing'); // maxAge 0 → always refetch
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('is repo-scoped and case-insensitive — every workspace shares one entry', async () => {
    noteIssueComment('posthog', 'PostHog', 74552, trunk(merged));
    expect((await readExternalQueueState('other-ws', 'PostHog', 'posthog', 74552, 60_000))?.state)
      .toBe('merged');
    expect(list).not.toHaveBeenCalled();
  });

  it('ignores a comment that is not the provider queue comment', async () => {
    // A PR gets plenty of other comments (including trunk's own flaky-test
    // one); none of them may overwrite a real observation with "no state".
    noteIssueComment('PostHog', 'posthog', 74552, trunk(merged));
    noteIssueComment('PostHog', 'posthog', 74552, { body: 'lgtm', user: { login: 'Gilbert09' } });
    noteIssueComment('PostHog', 'posthog', 74552, trunk('<!-- Trunk Test Analytics -->\n| Failed |'));
    expect((await read())?.state).toBe('merged');
    expect(list).not.toHaveBeenCalled();
  });

  it('caches "the provider has said nothing" so a plain repo is not re-read', async () => {
    list.mockResolvedValue([{ body: 'ship it', user: { login: 'Gilbert09' } }]);
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('keeps a stale observation when GitHub refuses the read', async () => {
    noteIssueComments('PostHog', 'posthog', 74552, [trunk(testing)]);
    list.mockRejectedValue(new Error('403'));
    expect((await read(0))?.state).toBe('testing');
  });

  it('returns null (never a guess) when GitHub refuses and nothing was cached', async () => {
    list.mockRejectedValue(new Error('403'));
    expect(await read()).toBeNull();
  });
});

describe('externalStateMaxAge', () => {
  const entry = (o: Partial<EntrySnapshot>): EntrySnapshot =>
    ({
      id: 'mqe_1',
      status: 'queued',
      blockedCode: null,
      blockedReason: null,
      headSha: 'sha1',
      fixAttempts: 0,
      rerunAttempts: 0,
      resignAttempts: 0,
      submitAttempts: 0,
      externalSubmitVia: null,
      externalSubmittedAt: null,
      externalState: null,
      fixTaskId: null,
      fixTaskAccounted: true,
      fixKind: null,
      signingCheckedSha: null,
      unsignedCount: null,
      automergeArmedBy: null,
      mergeMethod: 'squash',
      baseBranch: 'main',
      ...o,
    }) as EntrySnapshot;

  it('asks for nothing when the entry has no stake in the external queue', () => {
    expect(externalStateMaxAge(entry({ status: 'queued' }))).toBeNull();
    expect(externalStateMaxAge(entry({ status: 'fixing' }))).toBeNull();
    expect(
      externalStateMaxAge(entry({ status: 'blocked', blockedCode: 'attempts_exhausted' }))
    ).toBeNull();
  });

  it('re-asks quickly while waiting for the provider to answer at all', () => {
    // The wrong answer here BLOCKS the PR, and the provider reacts in ~30s.
    expect(externalStateMaxAge(entry({ status: 'awaiting_external' }))).toBe(60_000);
    expect(
      externalStateMaxAge(entry({ status: 'awaiting_external', externalState: 'not_submitted' }))
    ).toBe(60_000);
  });

  it('backs off to a webhook backstop once the provider IS working the PR', () => {
    // Every trunk state change edits its comment → a webhook → a fresh cache
    // entry. This only bounds how long a MISSED delivery can mislead us.
    expect(
      externalStateMaxAge(entry({ status: 'awaiting_external', externalState: 'testing' }))
    ).toBe(600_000);
  });

  it('keeps probing an external block, slowly, so a self-heal can happen', () => {
    expect(
      externalStateMaxAge(entry({ status: 'blocked_manual', blockedCode: 'external_gate' }))
    ).toBe(600_000);
    expect(
      externalStateMaxAge(entry({ status: 'blocked', blockedCode: 'external_queue_rejected' }))
    ).toBe(600_000);
  });
});
