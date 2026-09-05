import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MERGEABLE_TEMPLATE,
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_SKILL_TEMPLATE,
  PROMPT_KINDS,
  PROMPT_TEMPLATE_MAX_CHARS,
  buildMergeablePrompt,
  buildSkillPrompt,
  defaultPromptTemplateHash,
  promptDefaultChangedSince,
  promptTemplateFor,
  promptTemplateHash,
  promptTemplateOverride,
  promptTemplateVariables,
  promptVariablesFor,
  renderPromptTemplate,
  validatePromptTemplate,
  type CloudProviderType,
  type PRMergeableSummary,
  type PromptKind,
  type SkillPromptInput,
} from '@talyn/shared';

const summary: PRMergeableSummary = {
  url: 'https://github.com/acme/widgets/pull/7',
  title: 'Add gizmo',
  headBranch: 'feature/x',
  baseBranch: 'main',
  mergeable: 'CONFLICTING',
  blockingReason: 'merge_conflicts',
  reviewDecision: null,
  checks: { total: 3, failed: 1 },
  unresolvedReviewThreads: 2,
};

const mergeableInput = { owner: 'acme', repo: 'widgets', number: 7, summary };

const skillInput: SkillPromptInput = {
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  pr: { url: 'https://github.com/acme/widgets/pull/42', title: 'Add gizmo', headBranch: 'feat/gizmo', baseBranch: 'main' },
  skill: { name: 'pr-review', description: 'Thorough review', content: '# Review\n\nBe careful.', source: 'platform' },
  provider: 'posthog_code',
};

describe('renderPromptTemplate', () => {
  it('substitutes known variables and leaves unknown ones as written', () => {
    expect(renderPromptTemplate('Hi {{name}} from {{ where }} ({{nope}})', { name: 'Ada', where: 'London' })).toBe(
      'Hi Ada from London ({{nope}})'
    );
  });

  it('never re-scans inserted values, so mustache inside a value survives', () => {
    expect(renderPromptTemplate('{{content}}', { content: 'use {{name}} here', name: 'X' })).toBe('use {{name}} here');
  });

  it('drops empty blocks together with the blank lines around them', () => {
    const out = renderPromptTemplate('A\n\n{{empty}}\n\n{{alsoEmpty}}\n\nB', { empty: '', alsoEmpty: '' });
    expect(out).toBe('A\n\nB');
  });

  it('keeps a value that is only whitespace-adjacent intact', () => {
    expect(renderPromptTemplate('- {{a}}\n- {{b}}', { a: 'one', b: 'two' })).toBe('- one\n- two');
  });

  it('collapses whitespace-only lines left behind by an empty block', () => {
    expect(renderPromptTemplate('A\n  \n{{gone}}\n \t\nB', { gone: '' })).toBe('A\n\nB');
  });

  it('substitutes a variable used more than once', () => {
    expect(renderPromptTemplate('{{x}} and {{x}}', { x: 'y' })).toBe('y and y');
  });
});

describe('promptTemplateVariables', () => {
  it('lists each referenced variable once, in first-seen order', () => {
    expect(promptTemplateVariables('{{b}} {{a}} {{ b }} {{c.d}}')).toEqual(['b', 'a', 'c.d']);
  });
});

describe('validatePromptTemplate', () => {
  it.each<PromptKind>(PROMPT_KINDS)('accepts the shipped %s default', (kind) => {
    expect(validatePromptTemplate(kind, DEFAULT_PROMPT_TEMPLATES[kind])).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects an empty template', () => {
    const v = validatePromptTemplate('mergeable', '   \n');
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/empty/i);
  });

  it('rejects unknown variables and names them', () => {
    const v = validatePromptTemplate('mergeable', '{{pr.url}} {{gitRules}} {{bogus}} {{skill.content}}');
    expect(v.ok).toBe(false);
    expect(v.unknownVariables).toEqual(['bogus', 'skill.content']);
    expect(v.errors.join(' ')).toContain('{{bogus}}');
  });

  it.each([
    ['skill', '{{pr.url}} {{gitRules}} {{skill.content}} {{issues}}', ['issues']],
    ['skill', '{{pr.url}} {{gitRules}} {{skill.content}} {{loopRules}} {{baseUpdateFlow}}', ['loopRules', 'baseUpdateFlow']],
    ['mergeable', '{{pr.url}} {{gitRules}} {{skill.location}}', ['skill.location']],
  ] as const)('%s: treats variables scoped to the other kind as unknown (%s)', (kind, template, unknown) => {
    const v = validatePromptTemplate(kind, template);
    expect(v.ok).toBe(false);
    expect(v.unknownVariables).toEqual(unknown);
  });

  it.each([
    ['mergeable', 'Fix {{pr.url}} please', ['gitRules']],
    ['mergeable', 'Fix it {{gitRules}}', ['pr.url']],
    ['skill', 'Run on {{pr.url}} {{gitRules}}', ['skill.content']],
    ['skill', '{{skill.content}}', ['pr.url', 'gitRules']],
  ] as const)('%s: reports the missing required variables (%s)', (kind, template, missing) => {
    const v = validatePromptTemplate(kind, template);
    expect(v.ok).toBe(false);
    expect(v.missingRequired).toEqual(missing);
  });

  it('rejects an oversized template', () => {
    const v = validatePromptTemplate('mergeable', `{{pr.url}} {{gitRules}} ${'x'.repeat(PROMPT_TEMPLATE_MAX_CHARS)}`);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/limit/);
  });

  it('only offers skill variables to the skill kind', () => {
    const mergeableNames = promptVariablesFor('mergeable').map((v) => v.name);
    const skillNames = promptVariablesFor('skill').map((v) => v.name);
    expect(mergeableNames).not.toContain('skill.content');
    expect(skillNames).toContain('skill.content');
    expect(skillNames).not.toContain('baseUpdateFlow');
    expect(mergeableNames).toContain('baseUpdateFlow');
  });
});

describe('promptTemplateHash', () => {
  it('is stable and 8 hex chars', () => {
    expect(promptTemplateHash('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(promptTemplateHash('abc')).toBe(promptTemplateHash('abc'));
    expect(promptTemplateHash('abc')).not.toBe(promptTemplateHash('abd'));
  });

  it('flags an override whose default has since changed', () => {
    const fresh = { template: 'x {{pr.url}} {{gitRules}}', basedOnHash: defaultPromptTemplateHash('mergeable'), updatedAt: 'now' };
    expect(promptDefaultChangedSince(fresh, 'mergeable')).toBe(false);
    expect(promptDefaultChangedSince({ ...fresh, basedOnHash: '00000000' }, 'mergeable')).toBe(true);
  });
});

describe('promptTemplateFor / promptTemplateOverride', () => {
  it('returns the default when there is no override, or the override is blank/null', () => {
    expect(promptTemplateFor(undefined, 'mergeable')).toBe(DEFAULT_MERGEABLE_TEMPLATE);
    expect(promptTemplateFor({ prompts: {} }, 'skill')).toBe(DEFAULT_SKILL_TEMPLATE);
    expect(promptTemplateFor({ prompts: { mergeable: null } }, 'mergeable')).toBe(DEFAULT_MERGEABLE_TEMPLATE);
    expect(
      promptTemplateFor({ prompts: { mergeable: { template: '  ', basedOnHash: 'x', updatedAt: 'y' } } }, 'mergeable')
    ).toBe(DEFAULT_MERGEABLE_TEMPLATE);
    expect(promptTemplateOverride({ prompts: {} }, 'mergeable')).toBeUndefined();
  });

  it('returns the override when present', () => {
    const override = { template: 'custom {{pr.url}} {{gitRules}}', basedOnHash: 'deadbeef', updatedAt: 'y' };
    expect(promptTemplateFor({ prompts: { mergeable: override } }, 'mergeable')).toBe(override.template);
    expect(promptTemplateOverride({ prompts: { mergeable: override } }, 'mergeable')).toEqual(override);
  });
});

describe('buildMergeablePrompt with a workspace template', () => {
  it.each<CloudProviderType>(['posthog_code', 'selfhosted'])(
    'renders the override with provider-aware variables (%s)',
    (provider) => {
      const prompt = buildMergeablePrompt({
        ...mergeableInput,
        provider,
        template: 'Fix {{pr.ref}} ({{pr.url}}) on {{pr.headBranch}} -> {{pr.baseBranch}}\n\n{{gitRules}}\n\nIssues:\n{{issues}}',
      });
      expect(prompt).toContain('Fix acme/widgets#7 (https://github.com/acme/widgets/pull/7) on feature/x -> main');
      expect(prompt).toContain('- Unresolved review threads: 2');
      expect(prompt).toContain('- Failing CI checks: 1/3');
      if (provider === 'selfhosted') {
        expect(prompt).toContain('fleet-publish');
        expect(prompt).not.toContain('git_signed_commit');
      } else {
        expect(prompt).toContain('git_signed_commit');
      }
      expect(prompt).not.toContain('Every reviewer comment');
    }
  );

  it('an override without a variable simply omits that block', () => {
    const prompt = buildMergeablePrompt({ ...mergeableInput, provider: 'posthog_code', template: '{{pr.url}}\n{{gitRules}}' });
    expect(prompt).not.toContain('COMMENT FOOTER');
    expect(prompt).not.toContain('Loop discipline');
  });

  it('exposes the PR title and every documented mergeable variable', () => {
    const template = promptVariablesFor('mergeable').map((v) => `[${v.name}]={{${v.name}}}`).join('\n');
    const prompt = buildMergeablePrompt({ ...mergeableInput, provider: 'posthog_code', template });
    expect(prompt).toContain('[pr.title]=Add gizmo');
    expect(prompt).toContain('[pr.number]=7');
    expect(prompt).toContain('[repo]=acme/widgets');
    expect(prompt).not.toMatch(/\{\{[\w.]+\}\}/);
  });
});

describe('default mergeable prompt: reviewer comments need judgement', () => {
  it.each<CloudProviderType>(['posthog_code', 'selfhosted'])('treats bot comments as advisory (%s)', (provider) => {
    const prompt = buildMergeablePrompt({ ...mergeableInput, provider });
    expect(prompt).toContain('BOTS and automated reviewers');
    expect(prompt).toContain('ADVISORY');
    expect(prompt).toMatch(/check the claim against the actual code/i);
    expect(prompt).toMatch(/Push back when/);
    expect(prompt).toMatch(/Never widen the PR's scope on a bot's say-so/);
    expect(prompt).toMatch(/Do NOT silently ignore a comment/);
    expect(prompt).not.toMatch(/correct or reasonable/);
  });

  it('keeps human reviewer feedback as the priority', () => {
    const prompt = buildMergeablePrompt({ ...mergeableInput, provider: 'posthog_code' });
    expect(prompt).toContain('HUMAN reviewers: their feedback takes priority');
  });
});

describe('buildSkillPrompt with a workspace template', () => {
  it('renders the override with the fenced skill and provider rules', () => {
    const prompt = buildSkillPrompt({
      ...skillInput,
      provider: 'selfhosted',
      template: 'Run {{skill.name}} on {{pr.url}}\n{{gitRules}}\n{{skill.content}}\n{{skill.location}}END',
    });
    expect(prompt).toContain('Run pr-review on https://github.com/acme/widgets/pull/42');
    expect(prompt).toContain('~~~~\n# Review\n\nBe careful.\n~~~~');
    expect(prompt).toContain('fleet-publish');
    expect(prompt).toMatch(/~~~~\nEND$/);
  });

  it('a skill full of mustache renders untouched', () => {
    const prompt = buildSkillPrompt({
      ...skillInput,
      skill: { ...skillInput.skill, content: 'Say {{pr.url}} literally' },
      template: '{{pr.url}} {{gitRules}} {{skill.content}}',
    });
    expect(prompt).toContain('Say {{pr.url}} literally');
    expect(prompt.startsWith('https://github.com/acme/widgets/pull/42')).toBe(true);
  });

  it('the default keeps the same shape as before: PR context, skill, job, decisiveness', () => {
    const prompt = buildSkillPrompt(skillInput);
    expect(prompt).toContain('## Skill: pr-review');
    expect(prompt).toContain('Thorough review');
    expect(prompt).toContain('## Your job');
    expect(prompt).toContain('Apply this skill to acme/widgets#42 specifically');
    expect(prompt).toContain('Be decisive');
    expect(prompt).not.toContain('This skill also lives in your checkout');
  });

  it('mentions the checkout path for repo skills', () => {
    const prompt = buildSkillPrompt({
      ...skillInput,
      skill: { ...skillInput.skill, source: 'repo', repoPath: '.claude/skills/pr-review/SKILL.md' },
    });
    expect(prompt).toContain('This skill also lives in your checkout at `.claude/skills/pr-review/SKILL.md`');
  });

  it('exposes every documented skill variable', () => {
    const template = promptVariablesFor('skill').map((v) => `[${v.name}]={{${v.name}}}`).join('\n');
    const prompt = buildSkillPrompt({
      ...skillInput,
      skill: { ...skillInput.skill, source: 'repo', repoPath: '.claude/skills/pr-review/SKILL.md' },
      template,
    });
    expect(prompt).toContain('[skill.name]=pr-review');
    expect(prompt).toContain('[skill.description]=Thorough review');
    expect(prompt).toContain('[pr.ref]=acme/widgets#42');
    expect(prompt).not.toMatch(/\{\{[\w.]+\}\}/);
  });
});
