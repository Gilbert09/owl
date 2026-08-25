import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildIssuesSummary,
  buildMergeablePrompt,
  DEFAULT_MERGEABLE_TEMPLATE,
  type PRMergeableSummary,
} from '@talyn/shared';

/**
 * A fix run used to be told only "Failing CI checks: 2/199". The agent then went
 * looking for which ones, and the cheapest thing to find is the PR's own comment
 * history — so a verdict that was true on an older head ("this semgrep failure is
 * a repo-wide infra bug") kept getting re-affirmed after the repo had fixed it,
 * while the finding actually named a file the PR itself added. Naming the checks
 * at dispatch, pinned to the head they were read on, is what makes the stale
 * comment recognisable as the older fact.
 */

const base: PRMergeableSummary = {
  url: 'https://github.com/acme/widgets/pull/7',
  headBranch: 'feature/x',
  baseBranch: 'main',
  mergeable: 'MERGEABLE',
  blockingReason: 'checks_failed',
  reviewDecision: null,
  checks: { total: 199, failed: 2 },
} as unknown as PRMergeableSummary;

describe('buildIssuesSummary — failing check names', () => {
  it('names the checks and pins them to the head they were read on', () => {
    const line = buildIssuesSummary(base, {
      headSha: '8fb157248cc8ab86535cf80428d466b80635a06b',
      names: ['Semgrep Checks Pass', 'semgrep-devex'],
    });
    expect(line).toContain('- Failing CI checks: 2/199');
    expect(line).toContain('`semgrep-devex`');
    expect(line).toContain('`Semgrep Checks Pass`');
    expect(line).toContain('as of head 8fb1572');
    // Abbreviated, never the full 40-char oid — the prompt is prose.
    expect(line).not.toContain('8fb157248cc8ab86535cf80428d466b80635a06b');
  });

  it.each([
    ['no reading at all', undefined],
    ['a reading that found no names', { headSha: 'abc1234', names: [] }],
  ])('leaves the line exactly as it was when there is %s', (_label, reading) => {
    expect(buildIssuesSummary(base, reading)).toBe('- Failing CI checks: 2/199');
  });

  it('keeps the not-required note alongside the names', () => {
    const line = buildIssuesSummary(
      { ...base, blockingReason: 'checks_failed_optional' } as PRMergeableSummary,
      { headSha: 'abc1234def', names: ['lint'] }
    );
    expect(line).toContain('(none required — not blocking the merge)');
    expect(line).toContain('`lint`');
  });

  it('carries the names into the rendered prompt', () => {
    const prompt = buildMergeablePrompt({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      summary: base,
      provider: 'posthog_code',
      failingChecks: { headSha: '8fb157248cc8ab', names: ['semgrep-devex'] },
    });
    expect(prompt).toContain('`semgrep-devex`');
  });
});

describe('DEFAULT_MERGEABLE_TEMPLATE — a stale verdict is not evidence', () => {
  it('sends the run to the current head\'s own log, not to earlier status comments', () => {
    expect(DEFAULT_MERGEABLE_TEMPLATE).toMatch(/are not evidence/i);
    expect(DEFAULT_MERGEABLE_TEMPLATE).toMatch(/CURRENT head/);
  });

  it('makes "not this PR\'s fault" a claim that has to be proven against the log', () => {
    expect(DEFAULT_MERGEABLE_TEMPLATE).toMatch(/pre-existing/i);
    expect(DEFAULT_MERGEABLE_TEMPLATE).toMatch(/neither adds nor edits/);
  });
});

const listFailingCheckNames = vi.fn();
vi.mock('../services/github.js', () => ({
  githubService: {
    listFailingCheckNames: (...args: unknown[]) => listFailingCheckNames(...args),
  },
}));

describe('readFailingChecks', () => {
  beforeEach(() => listFailingCheckNames.mockReset());

  it('does not spend a call when the summary says nothing is failing', async () => {
    const { readFailingChecks } = await import('../services/failingChecks.js');
    const summary = { ...base, checks: { total: 199, failed: 0 } } as PRMergeableSummary;
    await expect(readFailingChecks('ws', 'acme', 'widgets', 7, summary)).resolves.toBeUndefined();
    expect(listFailingCheckNames).not.toHaveBeenCalled();
  });

  it('passes the reading through when names come back', async () => {
    const { readFailingChecks } = await import('../services/failingChecks.js');
    listFailingCheckNames.mockResolvedValue({ headSha: 'abc1234', names: ['semgrep-devex'] });
    await expect(readFailingChecks('ws', 'acme', 'widgets', 7, base)).resolves.toEqual({
      headSha: 'abc1234',
      names: ['semgrep-devex'],
    });
  });

  it.each([
    ['the read failed', null],
    ['the read found no names', { headSha: 'abc1234', names: [] }],
  ])('returns undefined — never a false "nothing failing" — when %s', async (_label, reading) => {
    const { readFailingChecks } = await import('../services/failingChecks.js');
    listFailingCheckNames.mockResolvedValue(reading);
    await expect(readFailingChecks('ws', 'acme', 'widgets', 7, base)).resolves.toBeUndefined();
  });
});
