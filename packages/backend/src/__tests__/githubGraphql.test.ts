import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  aliasForBranch,
  batchPullRequests,
  computeBlockingReason,
  computeCheckDigest,
  decodeBatchResponse,
  makeBatchPullRequestsQuery,
  normalizeCheckState,
} from '../services/githubGraphql.js';
import { githubService } from '../services/github.js';

describe('normalizeCheckState', () => {
  // CheckRun: status drives the verdict while !COMPLETED.
  it('returns pending for QUEUED / WAITING / PENDING status', () => {
    expect(normalizeCheckState({ status: 'QUEUED' })).toBe('pending');
    expect(normalizeCheckState({ status: 'WAITING' })).toBe('pending');
    expect(normalizeCheckState({ status: 'PENDING' })).toBe('pending');
  });

  it('returns in_progress for IN_PROGRESS status', () => {
    expect(normalizeCheckState({ status: 'IN_PROGRESS' })).toBe('in_progress');
  });

  // CheckRun: status COMPLETED → conclusion wins.
  it('maps SUCCESS / NEUTRAL conclusion to success', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('success');
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'NEUTRAL' })).toBe('success');
  });

  it('maps SKIPPED conclusion to skipped (not success)', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipped');
  });

  it('maps FAILURE / TIMED_OUT / STARTUP_FAILURE / ACTION_REQUIRED to failure', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failure');
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('failure');
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' })).toBe('failure');
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' })).toBe('failure');
  });

  it('maps CANCELLED conclusion to cancelled (its own state)', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'CANCELLED' })).toBe('cancelled');
  });

  it('treats unknown conclusion conservatively as failure', () => {
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'PURPLE' })).toBe('failure');
  });

  // StatusContext: legacy state field.
  it('maps StatusContext SUCCESS state to success', () => {
    expect(normalizeCheckState({ state: 'SUCCESS' })).toBe('success');
  });

  it('maps StatusContext FAILURE / ERROR to failure', () => {
    expect(normalizeCheckState({ state: 'FAILURE' })).toBe('failure');
    expect(normalizeCheckState({ state: 'ERROR' })).toBe('failure');
  });

  it('maps StatusContext PENDING / EXPECTED to pending', () => {
    expect(normalizeCheckState({ state: 'PENDING' })).toBe('pending');
    expect(normalizeCheckState({ state: 'EXPECTED' })).toBe('pending');
  });

  it('returns pending for an entirely empty input (defensive)', () => {
    expect(normalizeCheckState({})).toBe('pending');
  });

  it('is case-insensitive on input', () => {
    expect(normalizeCheckState({ status: 'in_progress' })).toBe('in_progress');
    expect(normalizeCheckState({ status: 'completed', conclusion: 'success' })).toBe('success');
  });
});

describe('computeBlockingReason', () => {
  const baseChecks = { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 };

  it('returns merge_conflicts when CONFLICTING (even if reviews + checks are clean)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 5, passed: 5 },
      })
    ).toBe('merge_conflicts');
  });

  it('returns changes_requested when reviewDecision says so (even if mergeable)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'CHANGES_REQUESTED',
        checks: baseChecks,
      })
    ).toBe('changes_requested');
  });

  it('returns checks_failed when there is at least one failed check', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'UNSTABLE',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 3, passed: 2, failed: 1 },
      })
    ).toBe('checks_failed');
  });

  it('returns mergeable for the happy path (CLEAN)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        checks: { ...baseChecks, total: 3, passed: 3 },
      })
    ).toBe('mergeable');
  });

  it('returns mergeable for HAS_HOOKS / UNSTABLE — these are still mergeable in practice', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'HAS_HOOKS',
        reviewDecision: null,
        checks: { ...baseChecks, total: 1, passed: 1 },
      })
    ).toBe('mergeable');
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'UNSTABLE',
        reviewDecision: null,
        checks: { ...baseChecks, total: 2, passed: 1, inProgress: 1 },
      })
    ).toBe('mergeable');
  });

  it('returns blocked for MERGEABLE + BLOCKED (branch protection)', () => {
    expect(
      computeBlockingReason({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        checks: { ...baseChecks, total: 0 },
      })
    ).toBe('blocked');
  });

  it('returns unknown when GitHub has not computed mergeable yet', () => {
    expect(
      computeBlockingReason({
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        reviewDecision: null,
        checks: baseChecks,
      })
    ).toBe('unknown');
  });

  it('priority order: conflicts wins over changes_requested wins over checks_failed', () => {
    // All three blocking signals at once → only one is surfaced. Conflicts
    // is the most actionable so wins.
    expect(
      computeBlockingReason({
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        reviewDecision: 'CHANGES_REQUESTED',
        checks: { ...baseChecks, total: 3, passed: 1, failed: 2 },
      })
    ).toBe('merge_conflicts');
  });
});

describe('computeCheckDigest', () => {
  it('is stable across input order (sorted internally)', () => {
    const a = computeCheckDigest('sha1', [
      { name: 'lint', state: 'success' },
      { name: 'test', state: 'failure' },
    ]);
    const b = computeCheckDigest('sha1', [
      { name: 'test', state: 'failure' },
      { name: 'lint', state: 'success' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when a check transitions state', () => {
    const before = computeCheckDigest('sha1', [{ name: 'test', state: 'in_progress' }]);
    const after = computeCheckDigest('sha1', [{ name: 'test', state: 'success' }]);
    expect(before).not.toBe(after);
  });

  it('changes when the head sha changes (force-push)', () => {
    const before = computeCheckDigest('shaA', [{ name: 'test', state: 'success' }]);
    const after = computeCheckDigest('shaB', [{ name: 'test', state: 'success' }]);
    expect(before).not.toBe(after);
  });
});

describe('makeBatchPullRequestsQuery', () => {
  it('aliases each branch under the single repository node', () => {
    const q = makeBatchPullRequestsQuery(['main', 'feature/x']);
    expect(q).toMatch(/repository\(owner: \$owner, name: \$repo\)/);
    expect(q).toContain(`${aliasForBranch(0)}: pullRequests(headRefName: "main"`);
    expect(q).toContain(`${aliasForBranch(1)}: pullRequests(headRefName: "feature/x"`);
  });

  it('escapes weird branch names safely as JSON strings', () => {
    // Quotes and backslashes in a branch name must not break the query.
    const q = makeBatchPullRequestsQuery(['weird"name', 'with\\back']);
    expect(q).toContain('"weird\\"name"');
    expect(q).toContain('"with\\\\back"');
  });

  it('embeds the PRFields fragment with statusCheckRollup + reviews + comments', () => {
    const q = makeBatchPullRequestsQuery(['main']);
    expect(q).toContain('fragment PRFields on PullRequest');
    expect(q).toContain('statusCheckRollup');
    expect(q).toContain('contexts(first: 100)');
    expect(q).toContain('reviews(last: 5)');
    // Both comment surfaces are pulled in the same round-trip so the
    // cursor delta-checker doesn't need a separate REST fan-out.
    expect(q).toContain('reviewThreads(last: 5)');
    expect(q).toContain('comments(last: 5)');
    expect(q).toContain('mergeable');
    expect(q).toContain('mergeStateStatus');
    expect(q).toContain('reviewDecision');
  });
});

describe('decodeBatchResponse', () => {
  function rawPR(over: Record<string, unknown> = {}): unknown {
    return {
      number: 42,
      title: 'Add feature',
      body: 'description',
      url: 'https://github.com/acme/widgets/pull/42',
      isDraft: false,
      state: 'OPEN',
      mergedAt: null,
      closedAt: null,
      updatedAt: '2026-01-01T00:00:00Z',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      author: { login: 'alice' },
      headRefName: 'feature/x',
      baseRefName: 'main',
      headRefOid: 'abcdef1',
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: 'SUCCESS',
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
      ...over,
    };
  }

  it('returns null for branches with no matching PR', () => {
    const result = decodeBatchResponse(
      ['feature/x'],
      { repository: { [aliasForBranch(0)]: { nodes: [] } } },
      'acme',
      'widgets'
    );
    expect(result).toEqual([{ branch: 'feature/x', pr: null }]);
  });

  it('returns all-null when the repository node itself is null (repo deleted/renamed)', () => {
    const result = decodeBatchResponse(['a', 'b'], { repository: null }, 'acme', 'widgets');
    expect(result).toEqual([
      { branch: 'a', pr: null },
      { branch: 'b', pr: null },
    ]);
  });

  it('decodes a happy-path PR with rolled-up checks', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: 'SUCCESS',
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              id: '1',
                              name: 'lint',
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS',
                            },
                            {
                              __typename: 'CheckRun',
                              id: '2',
                              name: 'test',
                              status: 'COMPLETED',
                              conclusion: 'FAILURE',
                            },
                            {
                              __typename: 'StatusContext',
                              id: '3',
                              context: 'ci/external',
                              state: 'PENDING',
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const result = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    );
    expect(result).toHaveLength(1);
    const pr = result[0].pr!;
    expect(pr.owner).toBe('acme');
    expect(pr.repo).toBe('widgets');
    expect(pr.number).toBe(42);
    expect(pr.headBranch).toBe('feature/x');
    expect(pr.baseBranch).toBe('main');
    expect(pr.headSha).toBe('abcdef1');
    expect(pr.checks).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      inProgress: 1,
      skipped: 0,
    });
    // Failed check trumps APPROVED review for the verdict.
    expect(pr.blockingReason).toBe('checks_failed');
  });

  it('treats a PR with no statusCheckRollup as zero checks (early-PR case)', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
            }),
          ],
        },
      },
    };
    const result = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    );
    const pr = result[0].pr!;
    expect(pr.checks.total).toBe(0);
    expect(pr.blockingReason).toBe('mergeable');
  });

  it('captures up to 5 recent reviews freshest-first (GitHub returns last:N oldest-first)', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              // GraphQL `last: 5` returns oldest-first within the window;
              // the decoder must reverse so freshest sits at index 0.
              reviews: {
                nodes: [
                  {
                    id: 'r-old',
                    author: { login: 'alice' },
                    state: 'COMMENTED',
                    submittedAt: '2026-01-01T00:00:00Z',
                    url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-r-old',
                  },
                  {
                    id: 'r-new',
                    author: { login: 'bob' },
                    state: 'APPROVED',
                    submittedAt: '2026-01-02T00:00:00Z',
                    url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-r-new',
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const result = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    );
    expect(result[0].pr?.recentReviews).toHaveLength(2);
    expect(result[0].pr?.recentReviews[0].id).toBe('r-new');
    expect(result[0].pr?.recentReviews[0].author).toBe('bob');
    expect(result[0].pr?.recentReviews[1].id).toBe('r-old');
  });

  it('flattens reviewThreads → recentReviewComments freshest-first', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              reviewThreads: {
                nodes: [
                  {
                    comments: {
                      nodes: [
                        {
                          id: 'rc-old',
                          author: { login: 'alice' },
                          createdAt: '2026-01-01T00:00:00Z',
                          url: 'https://github.com/acme/widgets/pull/42#discussion_r-old',
                        },
                      ],
                    },
                  },
                  {
                    comments: {
                      nodes: [
                        {
                          id: 'rc-new',
                          author: { login: 'bob' },
                          createdAt: '2026-01-02T00:00:00Z',
                          url: 'https://github.com/acme/widgets/pull/42#discussion_r-new',
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const pr = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    )[0].pr!;
    expect(pr.recentReviewComments.map((c) => c.id)).toEqual(['rc-new', 'rc-old']);
  });

  it('captures top-level PR comments freshest-first', () => {
    const data = {
      repository: {
        [aliasForBranch(0)]: {
          nodes: [
            rawPR({
              comments: {
                nodes: [
                  {
                    id: 'c-old',
                    author: { login: 'alice' },
                    createdAt: '2026-01-01T00:00:00Z',
                    url: 'https://github.com/acme/widgets/pull/42#issuecomment-c-old',
                  },
                  {
                    id: 'c-new',
                    author: { login: 'bob' },
                    createdAt: '2026-01-02T00:00:00Z',
                    url: 'https://github.com/acme/widgets/pull/42#issuecomment-c-new',
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const pr = decodeBatchResponse(
      ['feature/x'],
      data as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    )[0].pr!;
    expect(pr.recentComments.map((c) => c.id)).toEqual(['c-new', 'c-old']);
  });

  it('maps state MERGED / CLOSED to the lowercase variants', () => {
    const merged = decodeBatchResponse(
      ['x'],
      {
        repository: {
          [aliasForBranch(0)]: {
            nodes: [rawPR({ state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' })],
          },
        },
      } as Parameters<typeof decodeBatchResponse>[1],
      'acme',
      'widgets'
    );
    expect(merged[0].pr?.state).toBe('merged');
    expect(merged[0].pr?.mergedAt).toBe('2026-01-01T00:00:00Z');
  });
});

describe('batchPullRequests — orchestration', () => {
  beforeEach(() => {
    vi.spyOn(githubService, 'executeGraphql').mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] for an empty branch list without hitting GraphQL', async () => {
    const spy = vi.spyOn(githubService, 'executeGraphql');
    const out = await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches: [],
    });
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('chunks 60 branches into 3 queries (chunk size 25 → 25 + 25 + 10)', async () => {
    const spy = vi
      .spyOn(githubService, 'executeGraphql')
      .mockImplementation(async (_workspaceId, _query, _vars) => {
        // Return empty repository node — every branch comes back as null.
        // We assert the chunking, not the decoding, here.
        return { repository: {} } as never;
      });
    const branches = Array.from({ length: 60 }, (_, i) => `b/${i}`);
    const out = await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches,
    });
    expect(out).toHaveLength(60);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('passes owner + repo as variables on every query', async () => {
    const spy = vi
      .spyOn(githubService, 'executeGraphql')
      .mockResolvedValue({ repository: {} } as never);
    await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches: ['main'],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs[0]).toBe('ws1');
    expect(callArgs[2]).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('limits in-flight queries to 3 even when more chunks exist', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(githubService, 'executeGraphql').mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield to the event loop so the runner can hand work to siblings.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { repository: {} } as never;
    });
    // 250 branches → 10 chunks of 25 each.
    const branches = Array.from({ length: 250 }, (_, i) => `b/${i}`);
    await batchPullRequests({
      workspaceId: 'ws1',
      owner: 'acme',
      repo: 'widgets',
      branches,
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});
