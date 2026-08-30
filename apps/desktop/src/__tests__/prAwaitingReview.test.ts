import type { PRRow, PRReviewDecision, PRBlockingReason } from '../renderer/lib/api';
import { isAwaitingReview, isReadyToMerge } from '../renderer/components/panels/github/prTableShared';

function makeRow(summary: Partial<PRRow['summary']>): PRRow {
  return {
    id: 'p1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 1,
    state: 'open',
    reviewRequested: false,
    authored: true,
    watching: false,
    mergedAt: null,
    lastPolledAt: '2026-06-05T00:00:00Z',
    summary: { title: 'PR', draft: false, ...summary } as PRRow['summary'],
    autoKeepMergeable: false,
    autoMergeState: null,
    mergeQueued: false,
    mergeMethod: 'squash',
    mergeQueueState: null,
    createdAt: '2026-06-05T00:00:00Z',
    updatedAt: '2026-06-05T00:00:00Z',
  };
}

describe('isAwaitingReview — "Needs review" filter predicate', () => {
  it.each<[PRReviewDecision, boolean]>([
    ['REVIEW_REQUIRED', true],
    ['APPROVED', false],
    ['CHANGES_REQUESTED', false],
    [null, false],
  ])('reviewDecision %s → %s', (reviewDecision, expected) => {
    expect(isAwaitingReview(makeRow({ reviewDecision }))).toBe(expected);
  });

  it('prefers effectiveReviewDecision over the raw decision', () => {
    expect(
      isAwaitingReview(
        makeRow({ reviewDecision: 'APPROVED', effectiveReviewDecision: 'REVIEW_REQUIRED' })
      )
    ).toBe(true);
    expect(
      isAwaitingReview(
        makeRow({ reviewDecision: 'REVIEW_REQUIRED', effectiveReviewDecision: 'APPROVED' })
      )
    ).toBe(false);
  });

  it('never flags a draft, even when a review is required', () => {
    expect(isAwaitingReview(makeRow({ draft: true, reviewDecision: 'REVIEW_REQUIRED' }))).toBe(
      false
    );
  });
});

describe('isReadyToMerge — "Ready to merge" filter predicate', () => {
  const greenChecks = { total: 3, passed: 3, failed: 0, inProgress: 0, skipped: 0 };

  function readyRow(overrides: Partial<PRRow['summary']> = {}): PRRow {
    return makeRow({
      blockingReason: 'mergeable',
      checks: greenChecks,
      reviewDecision: 'APPROVED',
      ...overrides,
    });
  }

  it('flags a clean approved PR with green checks', () => {
    expect(isReadyToMerge(readyRow())).toBe(true);
  });

  it.each<[PRBlockingReason, boolean]>([
    ['mergeable', true],
    ['checks_failed_optional', true],
    ['merge_conflicts', false],
    ['changes_requested', false],
    ['checks_failed', false],
    ['blocked', false],
    ['unknown', false],
  ])('blockingReason %s → %s', (blockingReason, expected) => {
    expect(isReadyToMerge(readyRow({ blockingReason }))).toBe(expected);
  });

  it('never flags a draft, even when otherwise mergeable', () => {
    expect(isReadyToMerge(readyRow({ draft: true }))).toBe(false);
  });

  it('waits for in-progress checks to finish', () => {
    expect(
      isReadyToMerge(readyRow({ checks: { ...greenChecks, inProgress: 1 } }))
    ).toBe(false);
  });

  it.each<[PRReviewDecision, boolean]>([
    ['APPROVED', true],
    [null, true],
    ['REVIEW_REQUIRED', false],
  ])('reviewDecision %s → %s', (reviewDecision, expected) => {
    expect(isReadyToMerge(readyRow({ reviewDecision }))).toBe(expected);
  });

  it('respects effectiveReviewDecision over the raw decision (unprotected repos)', () => {
    expect(
      isReadyToMerge(
        readyRow({ reviewDecision: null, effectiveReviewDecision: 'REVIEW_REQUIRED' })
      )
    ).toBe(false);
    expect(
      isReadyToMerge(
        readyRow({ reviewDecision: 'REVIEW_REQUIRED', effectiveReviewDecision: 'APPROVED' })
      )
    ).toBe(true);
  });
});
