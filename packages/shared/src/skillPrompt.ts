// The "run this skill against this PR" prompt handed to a cloud run.
//
// Neither provider accepts skills natively, so the SKILL.md content is
// inlined verbatim (never truncated — see SKILL_MAX_BYTES in skills.ts).
// Like prMergeable.ts, the prompt is rendered from a template whose
// provider-specific parts (git/publishing rules) are variables, so a
// workspace override serves both providers.

import type { CloudProviderType } from './index.js';
import { fleetGitRules, githubToolsHint, postHogCodeGitRules, talynTaglineRule } from './prMergeable.js';
import { DEFAULT_SKILL_TEMPLATE, renderPromptTemplate } from './promptTemplates.js';
import type { SkillSource } from './skills.js';

export interface SkillPromptInput {
  owner: string;
  repo: string;
  number: number;
  pr: {
    url: string;
    title: string;
    headBranch: string;
    baseBranch: string;
  };
  skill: {
    name: string;
    description: string;
    /** Full SKILL.md text (frontmatter included is fine). */
    content: string;
    source: SkillSource;
    /** repo skills — path of SKILL.md inside the repo checkout. */
    repoPath?: string;
  };
  provider: CloudProviderType;
  /** A workspace override (Settings → Instructions); else the shipped default. */
  template?: string;
}

/**
 * Fence the skill content with a run of `~` longer than any tilde/backtick
 * fence the skill itself contains, so a skill full of code blocks can't
 * break out of its container.
 */
function fenceSkill(content: string): string {
  const longestFence = content.match(/^[~`]{4,}/gm)?.reduce((a, b) => (b.length > a.length ? b : a), '') ?? '';
  const fence = '~'.repeat(Math.max(4, longestFence.length + 1));
  return `${fence}\n${content.trimEnd()}\n${fence}`;
}

export function skillPromptVariables(input: SkillPromptInput): Record<string, string> {
  const { owner, repo, number, pr, skill, provider } = input;
  // Same publishing-dialect switch as mergeablePromptVariables — see the note
  // there on why the fleet cannot inherit PostHog's signed-git tool names.
  const fleet = provider === 'selfhosted';
  return {
    'pr.url': pr.url,
    'pr.number': String(number),
    'pr.ref': `${owner}/${repo}#${number}`,
    'pr.title': pr.title,
    'pr.headBranch': pr.headBranch,
    'pr.baseBranch': pr.baseBranch,
    repo: `${owner}/${repo}`,
    'skill.name': skill.name,
    'skill.description': skill.description ?? '',
    'skill.content': fenceSkill(skill.content),
    'skill.location': skill.repoPath
      ? `This skill also lives in your checkout at \`${skill.repoPath}\`; any supporting files the skill references are siblings of that file — read them from the checkout as needed.`
      : '',
    gitRules: fleet ? fleetGitRules(pr.baseBranch) : postHogCodeGitRules(pr.baseBranch),
    githubTools: githubToolsHint(provider),
    taglineRule: talynTaglineRule(),
  };
}

export function buildSkillPrompt(input: SkillPromptInput): string {
  return renderPromptTemplate(input.template ?? DEFAULT_SKILL_TEMPLATE, skillPromptVariables(input));
}
