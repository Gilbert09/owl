import { renderHook } from '@testing-library/react';
import type { PRRow } from '../renderer/lib/api';
import type { SkillSummary } from '@talyn/shared';

// ---- module mocks (useGitHubActions has many collaborators) ----
const openConnectAgent = jest.fn();
const createTask = jest.fn();
const patchRow = jest.fn();

let storeValue: Record<string, unknown>;
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: () => storeValue,
}));
jest.mock('../renderer/stores/pullRequests', () => ({
  usePullRequestStore: { getState: () => ({ patchRow, removeRow: jest.fn() }) },
}));
jest.mock('../renderer/hooks/useApi', () => ({
  useTaskActions: () => ({ createTask }),
}));
jest.mock('../renderer/hooks/usePullRequestSync', () => ({ refreshPullRequests: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/stores/billing', () => ({ maybeHandleBillingLimit: jest.fn() }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/lib/prClipboard', () => ({ copyRich: jest.fn() }));
jest.mock('../renderer/components/panels/github/stacks', () => ({ buildCopyListPayload: jest.fn() }));
jest.mock('../renderer/lib/api', () => ({ api: { tasks: { get: jest.fn() } } }));

import { useGitHubActions } from '../renderer/components/panels/github/useGitHubActions';

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

const skill: SkillSummary = { key: 'platform:1', source: 'platform', name: 'pr-review', description: '', id: '1' };

function setStore(over: Record<string, unknown> = {}) {
  storeValue = {
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', settings: {} }],
    environments: [],
    cloudProviders: [],
    selectTask: jest.fn(),
    tasks: [],
    addTask: jest.fn(),
    setActivePanel: jest.fn(),
    openSettings: jest.fn(),
    openConnectAgent,
    ...over,
  };
}

afterEach(() => jest.clearAllMocks());

describe('useGitHubActions — connect-agent gating', () => {
  it('createPostHogTask with no provider opens the connect modal and stashes the fix', async () => {
    setStore(); // no connected providers, no environments
    const { result } = renderHook(() => useGitHubActions());
    const created = await result.current.createPostHogTask(row);
    expect(created).toBe(false);
    expect(createTask).not.toHaveBeenCalled();
    expect(openConnectAgent).toHaveBeenCalledWith({ kind: 'fix', row, providerType: undefined });
  });

  it('runSkillTask with no provider opens the connect modal and stashes the skill', async () => {
    setStore();
    const { result } = renderHook(() => useGitHubActions());
    const created = await result.current.runSkillTask(row, skill, { localContent: 'body' });
    expect(created).toBe(false);
    expect(createTask).not.toHaveBeenCalled();
    expect(openConnectAgent).toHaveBeenCalledWith({
      kind: 'skill',
      row,
      skill,
      localContent: 'body',
      providerType: undefined,
    });
  });

  it('createPostHogTask with a connected provider dispatches the task instead of prompting', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    setStore({
      cloudProviders: [{ type: 'claude_code', connected: true, displayName: 'Claude Code' }],
      environments: [{ id: 'env1', type: 'claude_code' }],
    });
    const { result } = renderHook(() => useGitHubActions());
    const created = await result.current.createPostHogTask(row);
    expect(created).toBe(true);
    expect(openConnectAgent).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0][0]).toMatchObject({
      type: 'pr_response',
      assignedEnvironmentId: 'env1',
      pullRequestId: 'pr1',
    });
  });

  it('createPostHogTask renders the shipped default when nothing is customized', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    setStore({
      cloudProviders: [{ type: 'claude_code', connected: true, displayName: 'Claude Code' }],
      environments: [{ id: 'env1', type: 'claude_code' }],
    });
    const { result } = renderHook(() => useGitHubActions());
    await result.current.createPostHogTask(row);
    const prompt = createTask.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Every reviewer comment is resolved');
    expect(prompt).toContain('https://github.com/acme/w/pull/7');
  });

  it('createPostHogTask renders the workspace mergeable prompt override', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    setStore({
      workspaces: [
        {
          id: 'ws1',
          settings: {
            prompts: {
              mergeable: { template: 'Mine {{pr.ref}}\n{{gitRules}}', basedOnHash: '00000000', updatedAt: 'then' },
            },
          },
        },
      ],
      cloudProviders: [{ type: 'claude_code', connected: true, displayName: 'Claude Code' }],
      environments: [{ id: 'env1', type: 'claude_code' }],
    });
    const { result } = renderHook(() => useGitHubActions());
    await result.current.createPostHogTask(row);
    const prompt = createTask.mock.calls[0][0].prompt as string;
    expect(prompt.startsWith('Mine acme/w#7')).toBe(true);
    expect(prompt).toContain('`github` MCP server');
    expect(prompt).not.toContain('Every reviewer comment');
  });

  it('runSkillTask renders the workspace skill prompt override', async () => {
    createTask.mockResolvedValue({ id: 't1' });
    setStore({
      workspaces: [
        {
          id: 'ws1',
          settings: {
            prompts: {
              skill: {
                template: 'Skill {{skill.name}} on {{pr.ref}}\n{{gitRules}}\n{{skill.content}}',
                basedOnHash: '00000000',
                updatedAt: 'then',
              },
            },
          },
        },
      ],
      cloudProviders: [{ type: 'claude_code', connected: true, displayName: 'Claude Code' }],
      environments: [{ id: 'env1', type: 'claude_code' }],
    });
    const { result } = renderHook(() => useGitHubActions());
    const localSkill: SkillSummary = { ...skill, key: 'local:pr-review', source: 'local' };
    await result.current.runSkillTask(row, localSkill, { localContent: 'body' });
    const prompt = createTask.mock.calls[0][0].prompt as string;
    expect(prompt.startsWith('Skill pr-review on acme/w#7')).toBe(true);
    expect(prompt).toContain('body');
    expect(prompt).not.toContain('## Your job');
  });

  it('providerReady reflects whether a provider env resolves', () => {
    setStore();
    const { result: none } = renderHook(() => useGitHubActions());
    expect(none.current.providerReady).toBe(false);

    setStore({
      cloudProviders: [{ type: 'claude_code', connected: true, displayName: 'Claude Code' }],
      environments: [{ id: 'env1', type: 'claude_code' }],
    });
    const { result: ready } = renderHook(() => useGitHubActions());
    expect(ready.current.providerReady).toBe(true);
  });
});
