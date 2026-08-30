import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { PRRow } from '../renderer/lib/api';
import { api, ApiError } from '../renderer/lib/api';
import { toast } from '../renderer/stores/toast';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { WatchPRModal } from '../renderer/components/panels/github/WatchPRModal';
import { PRTable } from '../renderer/components/panels/github/prTableShared';

const spy = jest.spyOn.bind(jest);
const fn = jest.fn.bind(jest);

afterEach(() => {
  jest.restoreAllMocks();
});
/**
 * Manually watched PRs — a PR someone ELSE authored, added by URL so its CI
 * shows up on My PRs.
 *
 * The three things worth pinning here, all client-side:
 *   1. `applyPullRequestUpdate` PRESERVES `watching` when the echo omits it.
 *      Every poll tick and every prCache upsert emits without it, so getting
 *      this wrong silently drops a just-watched PR off the list.
 *   2. The My PRs cohort is `authored || watching`, and the "Watching" chip
 *      filters it, counts it, and is reset by Clear filters.
 *   3. WatchPRModal's two-phase repo confirmation.
 *
 * Duplicated in the other app on purpose: the renderer is a deliberate fork.
 */

function row(over: Partial<PRRow> = {}): PRRow {
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
    authored: false,
    watching: false,
    mergedAt: null,
    lastPolledAt: '',
    autoKeepMergeable: false,
    mergeQueued: false,
    mergeMethod: 'squash',
    createdAt: '',
    updatedAt: '',
    summary: {
      title: 'a PR',
      author: 'someone-else',
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
    } as PRRow['summary'],
    ...over,
  };
}

/** PRTable needs a couple of fields the store-level `row()` factory omits. */
function tableRow(over: Partial<PRRow> = {}): PRRow {
  return { ...row(), summary: { ...row().summary, url: 'https://github.com/acme/app/pull/1' }, ...over };
}

/** The repo warning is marked with data-attr (the project's convention for
 *  analytics + test hooks), not data-testid. */
function warning(): HTMLElement | null {
  return document.querySelector('[data-attr="watch-pr-repo-warning"]');
}

describe('pullRequests store — the watching flag', () => {
  beforeEach(() => {
    usePullRequestStore.setState({ rows: [] });
  });

  it('preserves watching when the echo omits it', () => {
    // The poll's flag reconcile and every prCache upsert emit this event with
    // no `watching` field. If the store overwrote instead of preserving, the
    // row would drop off My PRs within a tick of being added.
    usePullRequestStore.setState({ rows: [row({ watching: true })] });
    usePullRequestStore.getState().applyPullRequestUpdate({
      id: 'p1',
      taskId: null,
      state: 'open',
      lastSummary: { checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 } },
      authored: false,
      reviewRequested: false,
    });
    expect(usePullRequestStore.getState().rows[0].watching).toBe(true);
  });

  it('honours an explicit watching: false — the un-watch echo', () => {
    // Why the store uses `??` and not `||`.
    usePullRequestStore.setState({ rows: [row({ watching: true })] });
    usePullRequestStore.getState().applyPullRequestUpdate({
      id: 'p1',
      taskId: null,
      state: 'open',
      lastSummary: {},
      watching: false,
    });
    expect(usePullRequestStore.getState().rows[0].watching).toBe(false);
  });

  it('upsertRow inserts a minted row and replaces an existing one', () => {
    const r = row({ watching: true });
    usePullRequestStore.getState().upsertRow(r);
    expect(usePullRequestStore.getState().rows).toHaveLength(1);
    usePullRequestStore.getState().upsertRow({ ...r, number: 99 });
    expect(usePullRequestStore.getState().rows).toHaveLength(1);
    expect(usePullRequestStore.getState().rows[0].number).toBe(99);
  });
});

describe('My PRs cohort', () => {
  // The predicate the page applies. Kept as a plain assertion rather than a
  // full render because the page pulls in the whole table + detail sheet.
  const cohort = (rows: PRRow[]) => rows.filter((r) => r.authored || r.watching);

  it('includes a watched PR the user did not author', () => {
    const rows = [
      row({ id: 'mine', authored: true }),
      row({ id: 'watched', authored: false, watching: true }),
      row({ id: 'stranger', authored: false, watching: false }),
    ];
    expect(cohort(rows).map((r) => r.id)).toEqual(['mine', 'watched']);
  });
});

describe('WatchPRModal', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      repositories: [
        { id: 'repo1', workspaceId: 'ws1', owner: 'acme', repo: 'app', fullName: 'acme/app' },
      ],
    } as never);
    usePullRequestStore.setState({ rows: [] });
  });

  afterEach(() => {
    cleanup();
  });

  async function type(value: string) {
    fireEvent.change(screen.getByPlaceholderText(/github\.com\/owner\/repo\/pull/i), {
      target: { value },
    });
  }

  it('watches a PR in a repo the workspace already has', async () => {
    const watch = spy(api.pullRequests, 'watch').mockResolvedValue({
      ...row({ id: 'new', watching: true }),
      repoAdded: false,
      alreadyTracked: false,
    } as never);
    spy(toast, 'success').mockImplementation(() => 'id');
    const onOpenChange = fn();
    render(<WatchPRModal open onOpenChange={onOpenChange} />);

    await type('https://github.com/acme/app/pull/1');
    // No repo warning: the local list already answers it.
    expect(warning()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /watch pr/i }));

    await waitFor(() => expect(watch).toHaveBeenCalled());
    expect(watch.mock.calls[0][0]).toEqual({
      workspaceId: 'ws1',
      url: 'https://github.com/acme/app/pull/1',
      confirmAddRepo: undefined,
    });
    await waitFor(() => expect(usePullRequestStore.getState().rows).toHaveLength(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('warns up front when the local repo list already says the repo is missing', async () => {
    render(<WatchPRModal open onOpenChange={fn()} />);
    await type('https://github.com/other/thing/pull/5');
    expect(warning()!.textContent).toContain('other/thing');
    expect(screen.getByRole('button', { name: /add repo & watch pr/i })).toBeTruthy();
  });

  it('re-sends with confirmAddRepo after the server 409s repo_not_watched', async () => {
    // The server is the authority — this is the path where the local list was
    // stale, so nothing is shown until the 409 comes back.
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      repositories: [
        { id: 'repo1', workspaceId: 'ws1', owner: 'other', repo: 'thing', fullName: 'other/thing' },
      ],
    } as never);
    const watch = spy(api.pullRequests, 'watch')
      .mockRejectedValueOnce(new ApiError('nope', 409, 'repo_not_watched'))
      .mockResolvedValueOnce({
        ...row({ id: 'new', watching: true }),
        repoAdded: true,
        alreadyTracked: false,
      } as never);
    spy(toast, 'success').mockImplementation(() => 'id');
    render(<WatchPRModal open onOpenChange={fn()} />);

    await type('https://github.com/other/thing/pull/5');
    expect(warning()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /watch pr/i }));

    await waitFor(() =>
      expect(warning()!.textContent).toContain('other/thing')
    );
    expect(watch.mock.calls[0][0].confirmAddRepo).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: /add repo & watch pr/i }));
    await waitFor(() => expect(watch).toHaveBeenCalledTimes(2));
    expect(watch.mock.calls[1][0].confirmAddRepo).toBe(true);
  });

  it('reports an already-tracked PR as information, not an error', async () => {
    spy(api.pullRequests, 'watch').mockResolvedValue({
      ...row({ id: 'new', watching: true }),
      repoAdded: false,
      alreadyTracked: true,
    } as never);
    const info = spy(toast, 'info').mockImplementation(() => 'id');
    render(<WatchPRModal open onOpenChange={fn()} />);
    await type('acme/app#1');
    fireEvent.click(screen.getByRole('button', { name: /watch pr/i }));
    await waitFor(() => expect(info).toHaveBeenCalled());
    expect(info.mock.calls[0][0]).toContain('already in your list');
  });

  it('surfaces any other failure inline and stays open', async () => {
    spy(api.pullRequests, 'watch').mockRejectedValue(
      new ApiError("acme/app#9 doesn't exist", 404, 'pr_not_found')
    );
    const onOpenChange = fn();
    render(<WatchPRModal open onOpenChange={onOpenChange} />);
    await type('https://github.com/acme/app/pull/9');
    fireEvent.click(screen.getByRole('button', { name: /watch pr/i }));
    await waitFor(() => expect(screen.getByText(/doesn't exist/i)).toBeTruthy());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('the watch toggle in the PR row', () => {
  function renderRow(
    over: Partial<PRRow>,
    variant: 'mine' | 'review' | 'queue',
    onSetWatching: (r: PRRow, enabled: boolean) => Promise<void> = fn(async () => {})
  ) {
    render(
      <PRTable
        rows={[tableRow(over)]}
        variant={variant}
        viewerLogin="octocat"
        selectedId={null}
        onSelect={fn()}
        onOpenTask={fn()}
        onMerge={fn()}
        onSetMergeQueue={fn()}
        onSetWatching={onSetWatching}
        onStopTask={fn()}
        onCreatePostHogTask={fn()}
        taskStatusById={new Map()}
      />
    );
    return onSetWatching as jest.Mock;
  }

  const watchBtn = () => document.querySelector('[data-attr="pr-row-watch"]');
  const unwatchBtn = () => document.querySelector('[data-attr="pr-row-unwatch"]');

  it('offers the watch button on Reviews', () => {
    // The whole point: submitting a review clears `reviewRequested` and the PR
    // leaves this list, so this is where pinning it to My PRs is worth doing.
    renderRow({ authored: false, reviewRequested: true, watching: false }, 'review');
    expect(watchBtn()).toBeTruthy();
    expect(unwatchBtn()).toBeNull();
  });

  it('does not offer it on the other lists, where the flag adds nothing', () => {
    // An authored PR is already on My PRs; a queued one is already on the queue.
    renderRow({ authored: true, watching: false }, 'mine');
    expect(watchBtn()).toBeNull();
    cleanup();
    renderRow({ mergeQueued: true, watching: false }, 'queue');
    expect(watchBtn()).toBeNull();
  });

  it('shows the stop-tracking face wherever a watched PR renders', () => {
    for (const variant of ['mine', 'review', 'queue'] as const) {
      renderRow({ watching: true }, variant);
      expect(unwatchBtn()).toBeTruthy();
      expect(watchBtn()).toBeNull();
      cleanup();
    }
  });

  it('sends the opposite of the current state', async () => {
    const on = renderRow({ reviewRequested: true, watching: false }, 'review');
    fireEvent.click(watchBtn()!);
    await waitFor(() => expect(on).toHaveBeenCalled());
    expect(on.mock.calls[0][1]).toBe(true);
    cleanup();

    const off = renderRow({ watching: true }, 'review');
    fireEvent.click(unwatchBtn()!);
    await waitFor(() => expect(off).toHaveBeenCalled());
    expect(off.mock.calls[0][1]).toBe(false);
  });

  it('says the queue entry survives when stopping tracking on a queued PR', () => {
    renderRow({ watching: true, mergeQueued: true }, 'mine');
    expect(unwatchBtn()!.getAttribute('title')).toContain('merge queue entry stays active');
  });
});
