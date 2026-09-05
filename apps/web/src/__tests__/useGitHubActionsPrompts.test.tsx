import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PRRow } from '../lib/api';
import type { SkillSummary } from '@talyn/shared';

const { createTask, patchRow, state } = vi.hoisted(() => ({
  createTask: vi.fn(),
  patchRow: vi.fn(),
  state: { store: {} as Record<string, unknown> },
}));

vi.mock('../stores/workspace', () => ({ useWorkspaceStore: () => state.store }));
vi.mock('../stores/pullRequests', () => ({
  usePullRequestStore: { getState: () => ({ patchRow, removeRow: vi.fn() }) },
}));
vi.mock('../hooks/useApi', () => ({ useTaskActions: () => ({ createTask }) }));
vi.mock('../hooks/usePullRequestSync', () => ({ refreshPullRequests: vi.fn() }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../stores/billing', () => ({ maybeHandleBillingLimit: vi.fn() }));
vi.mock('../lib/githubInstall', () => ({ openGithubAppFlow: vi.fn() }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../lib/prClipboard', () => ({ copyRich: vi.fn() }));
vi.mock('../components/panels/github/stacks', () => ({ buildCopyListPayload: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { tasks: { get: vi.fn() } } }));

import { useGitHubActions } from '../components/panels/github/useGitHubActions';

const row = {
  id: 'pr1',
  owner: 'acme',
  repo: 'w',
  number: 7,
  repositoryId: 'r1',
  state: 'open',
  summary: {
    title: 'A PR',
    url: 'https://github.com/acme/w/pull/7',
    headBranch: 'f',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 0, failed: 0 },
  },
} as unknown as PRRow;

const skill: SkillSummary = { key: 'local:pr-review', source: 'local', name: 'pr-review', description: '', id: '1' };

function setStore(settings: Record<string, unknown>) {
  state.store = {
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', settings }],
    environments: [{ id: 'env1', type: 'posthog_code' }],
    cloudProviders: [{ type: 'posthog_code', connected: true, displayName: 'PostHog Code' }],
    selectTask: vi.fn(),
    tasks: [],
    addTask: vi.fn(),
    setActivePanel: vi.fn(),
    openSettings: vi.fn(),
    openConnectAgent: vi.fn(),
  };
}

afterEach(() => vi.clearAllMocks());

describe('useGitHubActions prompt templates', () => {
  it('createPostHogTask renders the shipped default when nothing is customized', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    setStore({});
    const { result } = renderHook(() => useGitHubActions());
    await result.current.createPostHogTask(row);
    const prompt = createTask.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Every reviewer comment is resolved');
    expect(prompt).toContain('https://github.com/acme/w/pull/7');
  });

  it('createPostHogTask renders the workspace mergeable prompt override', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    setStore({
      prompts: { mergeable: { template: 'Mine {{pr.ref}}\n{{gitRules}}', basedOnHash: '00000000', updatedAt: 'then' } },
    });
    const { result } = renderHook(() => useGitHubActions());
    await result.current.createPostHogTask(row);
    const prompt = createTask.mock.calls[0][0].prompt as string;
    expect(prompt.startsWith('Mine acme/w#7')).toBe(true);
    expect(prompt).toContain('git_signed_commit');
    expect(prompt).not.toContain('Every reviewer comment');
  });

  it('runSkillTask renders the workspace skill prompt override', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    setStore({
      prompts: {
        skill: {
          template: 'Skill {{skill.name}} on {{pr.ref}}\n{{gitRules}}\n{{skill.content}}',
          basedOnHash: '00000000',
          updatedAt: 'then',
        },
      },
    });
    const { result } = renderHook(() => useGitHubActions());
    await result.current.runSkillTask(row, skill, { localContent: 'body' });
    const prompt = createTask.mock.calls[0][0].prompt as string;
    expect(prompt.startsWith('Skill pr-review on acme/w#7')).toBe(true);
    expect(prompt).toContain('body');
    expect(prompt).not.toContain('## Your job');
  });
});
