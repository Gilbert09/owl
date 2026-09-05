import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { TaskStatus } from '@talyn/shared';
import type { PRRow } from '../lib/api';
import { toast } from '../stores/toast';
import { PRTable } from '../components/panels/github/prTableShared';

/**
 * The PR row's task slot is one button with two faces: the robot starts a
 * cloud run, and while that run is queued or in progress the same slot is a
 * Stop button. Stopping lands the task in `cancelled`, which the badge names
 * as Stopped rather than Failed.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */

vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('../hooks/useSkills', () => ({ useSkills: vi.fn() }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: () => ({ currentWorkspaceId: 'ws1' }),
}));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function row(taskId: string | null): PRRow {
  return {
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId,
    owner: 'acme',
    repo: 'app',
    number: 7,
    state: 'open',
    reviewRequested: false,
    authored: true,
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
      author: 'octocat',
      draft: false,
      headBranch: 'h',
      baseBranch: 'main',
      headSha: 'abc',
      updatedAt: '',
      url: 'https://github.com/acme/app/pull/7',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
      reviewDecision: null,
      blockingReason: 'checks_failed',
      checks: { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
  };
}

function renderRow(taskStatus: TaskStatus | undefined, onStopTask = vi.fn()) {
  const r = row(taskStatus ? 't1' : null);
  render(
    <PRTable
      rows={[r]}
      variant="mine"
      viewerLogin="octocat"
      selectedId={null}
      onSelect={vi.fn()}
      onOpenTask={vi.fn()}
      onStopTask={onStopTask}
      onMerge={vi.fn()}
      onSetMergeQueue={vi.fn()}
      onCreatePostHogTask={vi.fn()}
      taskStatusById={new Map(taskStatus ? [['t1', taskStatus]] : [])}
    />
  );
  return { onStopTask };
}

const stopButton = () => document.querySelector('[data-attr="pr-row-stop-task"]');
const robotButton = () => document.querySelector('[data-attr="pr-row-fix-with-posthog"]');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PR row task slot', () => {
  it.each<TaskStatus>(['pending', 'queued', 'in_progress'])(
    'shows Stop instead of the robot while the linked task is %s',
    (status) => {
      renderRow(status);
      expect(stopButton()).toBeTruthy();
      expect(robotButton()).toBeNull();
    }
  );

  it.each<TaskStatus | undefined>(['completed', 'failed', 'cancelled', undefined])(
    'shows the robot, not Stop, when the linked task is %s',
    (status) => {
      renderRow(status);
      expect(robotButton()).toBeTruthy();
      expect(stopButton()).toBeNull();
    }
  );

  it('stops the linked task on click', async () => {
    const { onStopTask } = renderRow('in_progress', vi.fn(async () => {}));
    fireEvent.click(stopButton()!);
    // The ROW rides along with the task id: stopping from a PR row also has to
    // reconcile that row, and the handler cannot re-find it from the id alone.
    await waitFor(() =>
      expect(onStopTask).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'pr1' })),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts the reason and re-enables the button when the stop is refused', async () => {
    renderRow('in_progress', vi.fn(async () => {
      throw new Error('Task is not running');
    }));
    fireEvent.click(stopButton()!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't stop the task on acme/app#7",
        'Task is not running'
      )
    );
    expect((stopButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['cancelled', 'Stopped'],
    ['failed', 'Failed'],
  ] as const)('labels the badge of a %s task "%s"', (status, label) => {
    renderRow(status);
    expect(screen.getByText(label)).toBeTruthy();
  });
});
