import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { PRFilterDefinition, Workspace } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import { api } from '../renderer/lib/api';
import { toast } from '../renderer/stores/toast';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import {
  PRFilterModal,
  SavedFilterBar,
  describeCriteria,
} from '../renderer/components/panels/github/savedFilters';

/**
 * The saved PR filter chips + the create/edit dialog. The MATCHING itself is
 * shared and tested in packages/backend/src/__tests__/prFilters.test.ts; what
 * this covers is the UI contract — chip counts, what the dialog sends, and the
 * two states it refuses to save from.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

function row(opts: { id: string; repo?: string; title?: string; labels?: string[] }): PRRow {
  return {
    id: opts.id,
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: opts.repo ?? 'app',
    number: 1,
    state: 'open',
    reviewRequested: false,
    authored: true,
    mergedAt: null,
    lastPolledAt: '',
    autoKeepMergeable: false,
    mergeQueued: false,
    mergeMethod: 'squash',
    createdAt: '',
    updatedAt: '',
    summary: {
      title: opts.title ?? 'a PR',
      author: 'octocat',
      draft: false,
      headBranch: 'h',
      baseBranch: 'main',
      headSha: 'abc',
      updatedAt: '',
      url: 'https://github.com/acme/app/pull/1',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      blockingReason: 'mergeable',
      checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
      labels: opts.labels,
    } as PRRow['summary'],
  };
}

function filter(over: Partial<PRFilterDefinition> = {}): PRFilterDefinition {
  return {
    id: 'f1',
    name: 'Frontend',
    criteria: { labels: ['frontend'] },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function workspace(prFilters?: PRFilterDefinition[]): Workspace {
  return {
    id: 'ws1',
    name: 'ws',
    repos: [],
    integrations: {},
    settings: prFilters ? { prFilters } : {},
    createdAt: '',
    updatedAt: '',
  };
}

function seed(prFilters?: PRFilterDefinition[]) {
  useWorkspaceStore.setState({
    workspaces: [workspace(prFilters)],
    currentWorkspaceId: 'ws1',
    repositories: [
      { id: 'repo1', workspaceId: 'ws1', fullName: 'acme/app' },
      { id: 'repo2', workspaceId: 'ws1', fullName: 'acme/site' },
    ] as never,
  });
}

// jsdom has no crypto.randomUUID; the renderer's Chromium does (and so does
// every other caller of it in the app).
beforeAll(() => {
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
      value: { ...globalThis.crypto, randomUUID: () => 'generated-id' },
      configurable: true,
    });
  }
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('SavedFilterBar', () => {
  const noop = () => {};

  it('counts each filter against the page rows, not the filtered list', () => {
    seed();
    render(
      <SavedFilterBar
        filters={[filter(), filter({ id: 'f2', name: 'Docs', criteria: { labels: ['docs'] } })]}
        activeIds={[]}
        onToggle={noop}
        onNew={noop}
        onEdit={noop}
        rows={[
          row({ id: '1', labels: ['frontend'] }),
          row({ id: '2', labels: ['frontend', 'docs'] }),
          row({ id: '3', labels: [] }),
        ]}
      />
    );
    expect(screen.getByTitle(/2 matching PRs/)).toHaveTextContent('Frontend2');
    expect(screen.getByTitle(/1 matching PR on this page/)).toHaveTextContent('Docs1');
  });

  it('toggles a filter by its chip and opens the editor from the pencil', () => {
    seed();
    const onToggle = jest.fn();
    const onEdit = jest.fn();
    const f = filter();
    render(
      <SavedFilterBar
        filters={[f]}
        activeIds={['f1']}
        onToggle={onToggle}
        onNew={noop}
        onEdit={onEdit}
        rows={[]}
      />
    );
    fireEvent.click(screen.getByText('Frontend'));
    expect(onToggle).toHaveBeenCalledWith('f1');
    fireEvent.click(screen.getByTitle('Edit "Frontend"'));
    expect(onEdit).toHaveBeenCalledWith(f);
  });

  it('always offers "New filter", even with none saved', () => {
    seed();
    render(
      <SavedFilterBar
        filters={[]}
        activeIds={[]}
        onToggle={noop}
        onNew={noop}
        onEdit={noop}
        rows={[]}
      />
    );
    expect(screen.getByText('New filter')).toBeInTheDocument();
  });
});

describe('PRFilterModal', () => {
  const open = (over: Partial<React.ComponentProps<typeof PRFilterModal>> = {}) => {
    const onSave = jest.fn().mockResolvedValue(true);
    const onDelete = jest.fn().mockResolvedValue(true);
    const onClose = jest.fn();
    render(
      <PRFilterModal
        open
        editing={null}
        onClose={onClose}
        onSave={onSave}
        onDelete={onDelete}
        saving={false}
        rows={[row({ id: '1', labels: ['frontend'] }), row({ id: '2', labels: ['docs'] })]}
        {...over}
      />
    );
    return { onSave, onDelete, onClose };
  };

  const name = () => screen.getByPlaceholderText(/Frontend, needs my review/) as HTMLInputElement;
  const labels = () => screen.getByPlaceholderText('bug, frontend') as HTMLInputElement;
  const title = () => screen.getByPlaceholderText('feat(') as HTMLInputElement;
  const create = () => screen.getByText('Create filter').closest('button') as HTMLButtonElement;

  it('refuses to save without a name', () => {
    seed();
    open();
    fireEvent.change(labels(), { target: { value: 'frontend' } });
    expect(create().disabled).toBe(true);
  });

  it('refuses to save with no criteria, and says why', () => {
    seed();
    open();
    fireEvent.change(name(), { target: { value: 'Everything' } });
    expect(create().disabled).toBe(true);
    expect(screen.getByText(/would match every PR/)).toBeInTheDocument();
  });

  it('previews how many of the page rows a draft matches', () => {
    seed();
    open();
    fireEvent.change(labels(), { target: { value: 'frontend' } });
    expect(screen.getByText('Matches 1 of 2 PRs on this page.')).toBeInTheDocument();
  });

  it('sends the parsed criteria and closes', async () => {
    seed();
    const { onSave, onClose } = open();
    fireEvent.change(name(), { target: { value: '  Frontend  ' } });
    fireEvent.change(labels(), { target: { value: ' frontend , bug , frontend ' } });
    fireEvent.change(title(), { target: { value: ' fix( ' } });
    fireEvent.click(screen.getByLabelText('acme/site'));
    fireEvent.click(create());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const def = onSave.mock.calls[0][0] as PRFilterDefinition;
    expect(def.name).toBe('Frontend');
    expect(def.criteria).toEqual({
      repos: ['acme/site'],
      labels: ['frontend', 'bug'],
      titleContains: 'fix(',
    });
    expect(def.id).toEqual(expect.any(String));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the id and createdAt when editing, and offers Delete', async () => {
    seed();
    const editing = filter({ criteria: { labels: ['frontend'], labelMatch: 'all' } });
    const { onSave, onDelete } = open({ editing });
    expect(name().value).toBe('Frontend');
    expect(labels().value).toBe('frontend');

    fireEvent.change(name(), { target: { value: 'FE' } });
    fireEvent.click(screen.getByText('Save').closest('button') as HTMLButtonElement);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const def = onSave.mock.calls[0][0] as PRFilterDefinition;
    expect(def.id).toBe('f1');
    expect(def.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(def.updatedAt).not.toBe('2026-08-01T00:00:00.000Z');
    expect(def.criteria.labelMatch).toBe('all');

    fireEvent.click(screen.getByText('Delete').closest('button') as HTMLButtonElement);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('f1'));
  });

  it('offers no Delete when creating', () => {
    seed();
    open();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});

describe('describeCriteria', () => {
  it.each([
    [{ labels: ['a', 'b'] }, 'any label: a, b'],
    [{ labels: ['a'], labelMatch: 'all' as const }, 'all labels: a'],
    [{ repos: ['acme/app'], titleContains: 'fix' }, 'repo: acme/app · title contains "fix"'],
    [{ excludeLabels: ['wip'] }, 'without: wip'],
    [{ authors: ['octocat'] }, 'author: octocat'],
    [{}, 'no criteria'],
  ])('%j → %s', (criteria, expected) => {
    expect(describeCriteria(criteria)).toBe(expected);
  });
});

describe('useSavedPRFilters (via the dialog)', () => {
  it('persists the whole list and patches the store', async () => {
    // The hook is exercised through a tiny harness rather than renderHook so
    // the test stays in the same shape as the rest of this file.
    seed([filter()]);
    const update = jest
      .spyOn(api.workspaces, 'update')
      .mockResolvedValue(workspace([filter(), filter({ id: 'f2', name: 'Docs' })]));
    jest.spyOn(toast, 'error').mockImplementation(() => 'id');

    const { useSavedPRFilters } = await import(
      '../renderer/components/panels/github/savedFilters'
    );
    let hook: ReturnType<typeof useSavedPRFilters> | null = null;
    function Harness() {
      hook = useSavedPRFilters();
      return null;
    }
    render(<Harness />);

    const next = filter({ id: 'f2', name: 'Docs', criteria: { labels: ['docs'] } });
    await hook!.upsert(next);

    expect(update).toHaveBeenCalledWith('ws1', {
      settings: { prFilters: [filter(), next] },
    });
    // The store takes the SERVER's normalised echo, not the local array.
    await waitFor(() =>
      expect(useWorkspaceStore.getState().workspaces[0].settings.prFilters).toHaveLength(2)
    );
  });

  it('a failed save toasts and leaves the stored list alone', async () => {
    seed([filter()]);
    jest.spyOn(api.workspaces, 'update').mockRejectedValue(new Error('nope'));
    const error = jest.spyOn(toast, 'error').mockImplementation(() => 'id');

    const { useSavedPRFilters } = await import(
      '../renderer/components/panels/github/savedFilters'
    );
    let hook: ReturnType<typeof useSavedPRFilters> | null = null;
    function Harness() {
      hook = useSavedPRFilters();
      return null;
    }
    render(<Harness />);

    expect(await hook!.remove('f1')).toBe(false);
    expect(error).toHaveBeenCalledWith('nope');
    expect(useWorkspaceStore.getState().workspaces[0].settings.prFilters).toEqual([filter()]);
  });
});
