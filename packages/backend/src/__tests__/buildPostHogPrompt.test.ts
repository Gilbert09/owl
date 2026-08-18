import { describe, it, expect } from 'vitest';
import {
  buildPostHogPrompt,
  buildMergeablePrompt,
  prNeedsFollowup,
  prHasFixableIssues,
  TALYN_COMMENT_TAGLINE,
  type PRMergeableSummary,
  type CloudProviderType,
} from '@talyn/shared';

/**
 * The cloud "make this PR mergeable" prompt must match the PostHog Code
 * sandbox's signed-git tool contract (PostHog/code#2574): base updates go
 * through `git_signed_merge`, conflicts through a local rebase published with
 * `git_signed_rewrite`, ordinary work through `git_signed_commit` — and the
 * guard against base-branch files leaking into the PR stays. We assert the
 * intent, not the exact wording, so the prompt can still evolve.
 */

const summary: PRMergeableSummary = {
  url: 'https://github.com/acme/widgets/pull/7',
  headBranch: 'feature/x',
  baseBranch: 'main',
  mergeable: 'CONFLICTING',
  blockingReason: 'conflicts',
  reviewDecision: null,
  checks: { total: 0, failed: 0, inProgress: 0, passed: 0 },
} as unknown as PRMergeableSummary;

describe('buildPostHogPrompt — signed-git tool contract', () => {
  const prompt = buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary });

  it('routes all publishing through the signed tools (raw commit/push are blocked)', () => {
    expect(prompt).toContain('git_signed_commit');
    expect(prompt).toContain('git_signed_merge');
    expect(prompt).toContain('git_signed_rewrite');
    expect(prompt.toLowerCase()).toContain('blocked');
  });

  it('directs base updates to git_signed_merge first', () => {
    expect(prompt).toMatch(/ALWAYS call `git_signed_merge` first/);
  });

  it('forbids the local-merge-then-signed-commit linearization path', () => {
    expect(prompt).toMatch(/NEVER run a local `git merge origin\/main` and then `git_signed_commit`/);
    expect(prompt.toUpperCase()).toContain('LINEARIZE');
  });

  it('scopes rebase to conflict resolution and publishes it via git_signed_rewrite', () => {
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toContain('git rebase --continue');
    expect(prompt).toMatch(/rebase[\s\S]*publish[\s\S]*`git_signed_rewrite`/i);
    expect(prompt.toLowerCase()).toContain('never rebase for any other reason');
  });

  it('treats signed-tool refusals as authoritative', () => {
    expect(prompt.toLowerCase()).toContain('refusal is authoritative');
  });

  it('still forbids single-parent imitations of a merge', () => {
    expect(prompt).toContain('git merge --squash');
    expect(prompt.toUpperCase()).toContain('ANCESTOR');
  });
});

describe('buildPostHogPrompt — base-merge leak guard', () => {
  const prompt = buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary });

  it('tells the agent to compare the PR file set before and after the base update', () => {
    expect(prompt).toContain('git diff --name-only origin/main...HEAD');
    expect(prompt.toLowerCase()).toContain('before');
    expect(prompt.toLowerCase()).toContain('after');
    expect(prompt.toLowerCase()).toContain('leak');
  });

  it('threads the real base branch into the guard and update commands', () => {
    const custom = buildPostHogPrompt({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      summary: { ...summary, baseBranch: 'develop' } as PRMergeableSummary,
    });
    expect(custom).toContain('git diff --name-only origin/develop...HEAD');
    expect(custom).toContain('git rebase origin/develop');
    expect(custom).not.toContain('origin/main...HEAD');
  });

  it('requires the deterministic post-update ancestor / behind-by assertion', () => {
    expect(prompt).toContain('git merge-base --is-ancestor origin/main HEAD');
    expect(prompt).toContain('git rev-list --count HEAD..origin/main');
  });
});

describe('buildMergeablePrompt — provider dispatch', () => {
  it('posthog_code matches the back-compat buildPostHogPrompt output', () => {
    expect(buildMergeablePrompt({ owner: 'acme', repo: 'widgets', number: 7, summary, provider: 'posthog_code' })).toBe(
      buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary })
    );
  });

  it('an unknown/deferred provider falls back to the PostHog variant', () => {
    expect(buildMergeablePrompt({ owner: 'acme', repo: 'widgets', number: 7, summary, provider: 'codex_cloud' })).toBe(
      buildPostHogPrompt({ owner: 'acme', repo: 'widgets', number: 7, summary })
    );
  });
});

describe('buildMergeablePrompt — claude_code variant (GitHub MCP, no signed-git/gh)', () => {
  const prompt = buildMergeablePrompt({
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    summary,
    provider: 'claude_code',
  });

  it('drops the PostHog-only signed-git tools and the gh CLI', () => {
    expect(prompt).not.toContain('git_signed_commit');
    expect(prompt).not.toContain('git_signed_merge');
    expect(prompt).not.toContain('git_signed_rewrite');
    expect(prompt).not.toContain('gh pr ');
  });

  it('publishes through the github MCP server', () => {
    expect(prompt).toContain('`github` MCP server');
    expect(prompt.toLowerCase()).toContain('no');
    expect(prompt).toMatch(/no .*`git push`/i);
  });

  it('keeps the same goals and base-leak guard, threading the real base branch', () => {
    expect(prompt).toContain('Every reviewer comment is resolved');
    expect(prompt).toContain('CI is fully green');
    expect(prompt).toContain('The branch merges cleanly');
    expect(prompt.toUpperCase()).toContain('ANCESTOR');
    expect(prompt.toLowerCase()).toContain('leak');
    expect(prompt).toContain('git diff --name-only origin/main...HEAD');
    expect(prompt).toContain('git merge-base --is-ancestor origin/main HEAD');
  });

  it('bounds the run for efficiency — no idling on CI, capped cycles, give up + comment', () => {
    expect(prompt).toContain('Efficiency');
    expect(prompt.toLowerCase()).toContain("don't babysit ci");
    expect(prompt).toMatch(/bound your effort/i);
    // It must NOT tell the agent to loop forever until everything is green.
    expect(prompt).not.toContain('do not hand control back until ALL conditions');
  });

  it('still permits local rebase for conflicts but never a single-parent base imitation', () => {
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toContain('git merge --squash');
    expect(prompt.toLowerCase()).toContain('single-parent');
  });
});

describe('buildMergeablePrompt — Talyn comment tagline', () => {
  it('exposes the linked, small-font tagline as the shared source of truth', () => {
    expect(TALYN_COMMENT_TAGLINE).toContain('talyn.dev');
    expect(TALYN_COMMENT_TAGLINE).toContain('https://talyn.dev');
    expect(TALYN_COMMENT_TAGLINE).toContain('<sub>'); // renders small on GitHub
  });

  it.each<CloudProviderType>(['posthog_code', 'claude_code', 'codex_cloud'])(
    'instructs every provider to append the exact tagline to comments (%s)',
    (provider) => {
      const prompt = buildMergeablePrompt({ owner: 'acme', repo: 'widgets', number: 7, summary, provider });
      expect(prompt).toContain(TALYN_COMMENT_TAGLINE);
      expect(prompt).toContain('COMMENT FOOTER');
      // Scoped to comments — never commit messages / PR description.
      expect(prompt).toMatch(/Do NOT add it to commit messages/);
    }
  );
});

describe('buildMergeablePrompt — re-sign section (signed-commits repos)', () => {
  it('is absent by default (no behaviour change for the common case)', () => {
    for (const provider of ['posthog_code', 'claude_code'] as CloudProviderType[]) {
      const prompt = buildMergeablePrompt({ owner: 'acme', repo: 'widgets', number: 7, summary, provider });
      expect(prompt).not.toContain('COMMIT SIGNING');
      expect(prompt).not.toMatch(/require signed commits/i);
    }
  });

  it('PostHog Code: re-sign via git_signed_rewrite + verify, threading the base branch', () => {
    const prompt = buildMergeablePrompt({
      owner: 'acme', repo: 'widgets', number: 7, provider: 'posthog_code',
      summary: { ...summary, baseBranch: 'develop' } as PRMergeableSummary,
      resignCommits: true,
    });
    expect(prompt).toContain('COMMIT SIGNING');
    expect(prompt).toMatch(/require.*signed commits/i);
    expect(prompt).toContain('git_signed_rewrite');
    expect(prompt).toContain('git log --show-signature origin/develop..HEAD');
    // Surfaced in the issues list too.
    expect(prompt.toLowerCase()).toContain('unsigned');
  });

  it('Claude Code: re-sign via the github MCP (no signed-git tools)', () => {
    const prompt = buildMergeablePrompt({
      owner: 'acme', repo: 'widgets', number: 7, summary, provider: 'claude_code',
      resignCommits: true,
    });
    expect(prompt).toContain('COMMIT SIGNING');
    expect(prompt).toContain('`github` MCP server');
    expect(prompt).not.toContain('git_signed_rewrite');
    expect(prompt.toLowerCase()).toContain('unsigned');
  });
});

describe('prHasFixableIssues vs prNeedsFollowup (manual button vs auto-fire)', () => {
  const base: PRMergeableSummary = {
    url: 'https://github.com/acme/app/pull/1',
    headBranch: 'feat',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    blockingReason: 'mergeable',
    checks: { total: 5, failed: 0 },
  };

  it('non-required failing checks enable the manual button but never auto-fire', () => {
    const s: PRMergeableSummary = {
      ...base,
      blockingReason: 'checks_failed_optional',
      checks: { total: 5, failed: 1 },
    };
    expect(prNeedsFollowup(s)).toBe(false); // watcher/queue stay quiet
    expect(prHasFixableIssues(s)).toBe(true); // human can still launch a run
  });

  it.each([
    ['merge conflicts', { ...base, blockingReason: 'merge_conflicts' } as PRMergeableSummary],
    ['required checks failed', { ...base, blockingReason: 'checks_failed', checks: { total: 5, failed: 2 } } as PRMergeableSummary],
    ['changes requested', { ...base, reviewDecision: 'CHANGES_REQUESTED' } as PRMergeableSummary],
    ['unresolved threads', { ...base, unresolvedReviewThreads: 2 } as PRMergeableSummary],
  ])('%s: both predicates agree (auto-fixable ⊆ manually-fixable)', (_label, s) => {
    expect(prNeedsFollowup(s)).toBe(true);
    expect(prHasFixableIssues(s)).toBe(true);
  });

  it('a clean PR enables neither', () => {
    expect(prNeedsFollowup(base)).toBe(false);
    expect(prHasFixableIssues(base)).toBe(false);
  });
});
