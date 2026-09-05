import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { SkillSummary } from '@talyn/shared';
import { SkillPickerModal } from '../renderer/components/panels/github/SkillPickerModal';
import type { PRRow } from '../renderer/lib/api';

const mockUseSkills = jest.fn();
jest.mock('../renderer/hooks/useSkills', () => ({
  useSkills: (...args: unknown[]) => mockUseSkills(...args),
}));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: () => ({ currentWorkspaceId: 'ws1' }),
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const skills: SkillSummary[] = [
  { key: 'repo:acme/w:lint-check', source: 'repo', name: 'lint-check', description: 'Lints the diff', repositoryId: 'r1', repoPath: '.claude/skills/lint-check/SKILL.md' },
  { key: 'platform:1', source: 'platform', name: 'pr-review', description: 'Reviews PRs', id: '1' },
  { key: 'local:notes', source: 'local', name: 'notes', description: '', localPath: '/x/SKILL.md' },
];

function mockSkillsResult(over: Record<string, unknown> = {}) {
  mockUseSkills.mockReturnValue({
    skills,
    localFiles: [{ dirName: 'notes', path: '/x/SKILL.md', size: 10, mtimeMs: 0, content: 'local body' }],
    usage: { 'platform:1': { count: 5, lastUsedAt: '2026-07-01T00:00:00Z' } },
    repoStatus: 'ok',
    loading: false,
    error: null,
    refresh: jest.fn(),
    ...over,
  });
}

const row = {
  id: 'pr1',
  owner: 'acme',
  repo: 'w',
  number: 7,
  repositoryId: 'r1',
  state: 'open',
  summary: { title: 'A PR', url: 'https://github.com/acme/w/pull/7', headBranch: 'f', baseBranch: 'main' },
} as unknown as PRRow;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('SkillPickerModal', () => {
  it('renders all sources grouped, with frequently-used on top', () => {
    mockSkillsResult();
    render(<SkillPickerModal row={row} open onClose={jest.fn()} onLaunch={jest.fn()} />);
    expect(screen.getByText('Frequently used')).toBeInTheDocument();
    expect(screen.getByText('In this repo (acme/w)')).toBeInTheDocument();
    expect(screen.getByText('On this machine')).toBeInTheDocument();
    expect(screen.getByText('lint-check')).toBeInTheDocument();
    // pr-review shows in "Frequently used" (used 5×) and not duplicated below.
    expect(screen.getAllByText('pr-review')).toHaveLength(1);
  });

  it('filters by search query', () => {
    mockSkillsResult();
    render(<SkillPickerModal row={row} open onClose={jest.fn()} onLaunch={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search skills…'), {
      target: { value: 'lint' },
    });
    expect(screen.getByText('lint-check')).toBeInTheDocument();
    expect(screen.queryByText('pr-review')).not.toBeInTheDocument();
    expect(screen.queryByText('Frequently used')).not.toBeInTheDocument();
  });

  it('launches immediately (passing local content) when not asking for a provider', async () => {
    mockSkillsResult();
    const onLaunch = jest.fn().mockResolvedValue(true);
    const onClose = jest.fn();
    render(<SkillPickerModal row={row} open onClose={onClose} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByText('notes'));
    await waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    const [calledRow, calledSkill, opts] = onLaunch.mock.calls[0];
    expect(calledRow.id).toBe('pr1');
    expect(calledSkill.key).toBe('local:notes');
    expect(opts.localContent).toBe('local body');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the provider step first when taskAsk is set', async () => {
    mockSkillsResult();
    const onLaunch = jest.fn().mockResolvedValue(true);
    render(
      <SkillPickerModal
        row={row}
        open
        onClose={jest.fn()}
        onLaunch={onLaunch}
        taskAsk
        taskProviders={[
          { type: 'posthog_code', displayName: 'PostHog Code' },
          { type: 'selfhosted', displayName: 'Talyn Fleet' },
        ]}
      />
    );
    fireEvent.click(screen.getByText('lint-check'));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByText('Run "lint-check" with…')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Talyn Fleet'));
    await waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    expect(onLaunch.mock.calls[0][2].providerType).toBe('selfhosted');
  });

  it('disables oversized skills with a badge', () => {
    mockSkillsResult({
      skills: [
        { key: 'local:huge', source: 'local', name: 'huge', description: '', contentSize: 300 * 1024 },
      ],
      usage: {},
    });
    const onLaunch = jest.fn();
    render(<SkillPickerModal row={row} open onClose={jest.fn()} onLaunch={onLaunch} />);
    expect(screen.getByText('Too large to run')).toBeInTheDocument();
    fireEvent.click(screen.getByText('huge'));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('shows the repo-error banner with a retry action', () => {
    const refresh = jest.fn();
    mockSkillsResult({ repoStatus: 'error', refresh });
    render(<SkillPickerModal row={row} open onClose={jest.fn()} onLaunch={jest.fn()} />);
    expect(screen.getByText("Couldn't load this repo's skills")).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(refresh).toHaveBeenCalledWith({ refreshRepo: true });
  });

  it('shows an empty state when nothing is available', () => {
    mockSkillsResult({ skills: [], localFiles: [], usage: {} });
    render(<SkillPickerModal row={row} open onClose={jest.fn()} onLaunch={jest.fn()} />);
    expect(screen.getByText(/No skills found/)).toBeInTheDocument();
  });
});
