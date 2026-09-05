import { describe, it, expect } from 'vitest';
import {
  buildSkillPrompt,
  parseSkillFrontmatter,
  postHogCodeGitRules,
  fleetGitRules,
  buildMergeablePrompt,
  TALYN_COMMENT_TAGLINE,
  type SkillPromptInput,
  type CloudProviderType,
} from '@talyn/shared';

function input(overrides: Partial<SkillPromptInput> = {}): SkillPromptInput {
  return {
    owner: 'acme',
    repo: 'widgets',
    number: 42,
    pr: {
      url: 'https://github.com/acme/widgets/pull/42',
      title: 'Add gizmo support',
      headBranch: 'feat/gizmo',
      baseBranch: 'main',
    },
    skill: {
      name: 'pr-review',
      description: 'Thorough PR review',
      content: '# Review\n\nDo a careful review.',
      source: 'platform',
    },
    provider: 'posthog_code',
    ...overrides,
  };
}

describe('parseSkillFrontmatter', () => {
  it('parses name and description from a frontmatter block', () => {
    const parsed = parseSkillFrontmatter('---\nname: my-skill\ndescription: Does things\n---\n\nBody here');
    expect(parsed.name).toBe('my-skill');
    expect(parsed.description).toBe('Does things');
    expect(parsed.body).toBe('Body here');
  });

  it('handles a file with no frontmatter', () => {
    const parsed = parseSkillFrontmatter('# Just markdown\n\nno frontmatter');
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe('# Just markdown\n\nno frontmatter');
  });

  it('handles an unterminated frontmatter block as body', () => {
    const raw = '---\nname: broken\nno closing fence';
    expect(parseSkillFrontmatter(raw).name).toBeUndefined();
    expect(parseSkillFrontmatter(raw).body).toBe(raw);
  });

  it.each([
    ['double quotes', 'name: "quoted name"', 'quoted name'],
    ['single quotes', "name: 'quoted name'", 'quoted name'],
    ['unquoted', 'name: plain-name', 'plain-name'],
    ['extra spaces', 'name:    spaced   ', 'spaced'],
  ])('strips %s from values', (_label, line, expected) => {
    const parsed = parseSkillFrontmatter(`---\n${line}\n---\nbody`);
    expect(parsed.name).toBe(expected);
  });

  it('handles CRLF line endings', () => {
    const parsed = parseSkillFrontmatter('---\r\nname: crlf-skill\r\ndescription: desc\r\n---\r\nbody');
    expect(parsed.name).toBe('crlf-skill');
    expect(parsed.description).toBe('desc');
  });

  it('ignores unknown keys and empty values', () => {
    const parsed = parseSkillFrontmatter('---\nname:\nallowed-tools: Bash\ndescription: d\n---\nbody');
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBe('d');
  });

  it('ignores nested/other lines without misparsing', () => {
    const parsed = parseSkillFrontmatter('---\nname: ok\nmetadata:\n  type: user\n---\nbody');
    expect(parsed.name).toBe('ok');
  });
});

describe('buildSkillPrompt', () => {
  it.each<CloudProviderType>(['posthog_code', 'selfhosted'])(
    'includes the PR context and skill content (%s)',
    (provider) => {
      const prompt = buildSkillPrompt(input({ provider }));
      expect(prompt).toContain('https://github.com/acme/widgets/pull/42');
      expect(prompt).toContain('acme/widgets');
      expect(prompt).toContain('#42');
      expect(prompt).toContain('feat/gizmo');
      expect(prompt).toContain('## Skill: pr-review');
      expect(prompt).toContain('Thorough PR review');
      expect(prompt).toContain('Do a careful review.');
    }
  );

  it('embeds the PostHog signed-git rules verbatim for posthog_code', () => {
    const prompt = buildSkillPrompt(input({ provider: 'posthog_code' }));
    expect(prompt).toContain(postHogCodeGitRules('main'));
    expect(prompt).not.toContain('NO `gh` CLI');
  });

  it('embeds the fleet publishing rules verbatim for selfhosted', () => {
    const prompt = buildSkillPrompt(input({ provider: 'selfhosted' }));
    expect(prompt).toContain(fleetGitRules('main'));
    expect(prompt).not.toContain('git_signed_commit');
  });

  it('falls back to the PostHog variant for unknown providers', () => {
    const prompt = buildSkillPrompt(input({ provider: 'codex_cloud' }));
    expect(prompt).toContain(postHogCodeGitRules('main'));
  });

  it('shares the git-rules text with the mergeable prompt (no drift)', () => {
    const mergeable = buildMergeablePrompt({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      summary: {
        url: 'https://github.com/acme/widgets/pull/42',
        headBranch: 'feat/gizmo',
        baseBranch: 'main',
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        blockingReason: 'mergeable',
        checks: { total: 0, failed: 0 },
      },
      provider: 'posthog_code',
    });
    expect(mergeable).toContain(postHogCodeGitRules('main'));
  });

  it('fences the skill content so embedded code fences cannot break out', () => {
    const content = 'Use this:\n\n```bash\necho hi\n```\n\nand also\n\n~~~~\nraw\n~~~~';
    const prompt = buildSkillPrompt(input({ skill: { ...input().skill, content } }));
    // The wrapping fence must be strictly longer than any fence inside.
    expect(prompt).toContain('~~~~~\n');
    expect(prompt).toContain(content.trimEnd());
  });

  it('points at the in-repo path for repo skills', () => {
    const prompt = buildSkillPrompt(
      input({
        skill: {
          ...input().skill,
          source: 'repo',
          repoPath: '.claude/skills/pr-review/SKILL.md',
        },
      })
    );
    expect(prompt).toContain('.claude/skills/pr-review/SKILL.md');
    expect(prompt).toContain('supporting files');
  });

  it('omits the repo-path note for platform/local skills', () => {
    expect(buildSkillPrompt(input())).not.toContain('also lives in your checkout');
  });

  it.each<CloudProviderType>(['posthog_code', 'selfhosted'])(
    'appends the shared Talyn comment tagline (%s)',
    (provider) => {
      const prompt = buildSkillPrompt(input({ provider }));
      expect(prompt).toContain(TALYN_COMMENT_TAGLINE);
      expect(prompt).toContain('COMMENT FOOTER');
    }
  );

  it('instructs publishing to the PR branch and a single review comment', () => {
    const prompt = buildSkillPrompt(input());
    expect(prompt).toContain('SINGLE PR review or comment');
    expect(prompt).toContain('feat/gizmo');
  });
});
