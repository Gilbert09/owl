import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { TaskStatus } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import { toast } from '../renderer/stores/toast';
import { PRTable } from '../renderer/components/panels/github/prTableShared';

/**
 * The PR row's task slot is one button with two faces: the robot starts a
 * cloud run, and while that run is queued or in progress the same slot is a
 * Stop button. Stopping lands the task in `cancelled`, which the badge names
 * as Stopped rather than Failed.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

jest.mock('../renderer/lib/api', () => ({ api: {} }));
jest.mock('../renderer/hooks/useSkills', () => ({ useSkills: jest.fn() }));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: () => ({ currentWorkspaceId: 'ws1' }),
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
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

function renderRow(taskStatus: TaskStatus | undefined, onStopTask = jest.fn()) {
  const r = row(taskStatus ? 't1' : null);
  render(
    <PRTable
      rows={[r]}
      variant="mine"
      viewerLogin="octocat"
      selectedId={null}
      onSelect={jest.fn()}
      onOpenTask={jest.fn()}
      onStopTask={onStopTask}
      onMerge={jest.fn()}
      onSetMergeQueue={jest.fn()}
      onCreatePostHogTask={jest.fn()}
      taskStatusById={new Map(taskStatus ? [['t1', taskStatus]] : [])}
    />
  );
  return { onStopTask };
}

const stopButton = () => document.querySelector('[data-attr="pr-row-stop-task"]');
const robotButton = () => document.querySelector('[data-attr="pr-row-fix-with-posthog"]');

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('PR row task slot', () => {
  it.each<TaskStatus>(['pending', 'queued', 'in_progress'])(
    'shows Stop instead of the robot while the linked task is %s',
    (status) => {
      renderRow(status);
      expect(stopButton()).toBeInTheDocument();
      expect(robotButton()).not.toBeInTheDocument();
    }
  );

  it.each<TaskStatus | undefined>(['completed', 'failed', 'cancelled', undefined])(
    'shows the robot, not Stop, when the linked task is %s',
    (status) => {
      renderRow(status);
      expect(robotButton()).toBeInTheDocument();
      expect(stopButton()).not.toBeInTheDocument();
    }
  );

  it('stops the linked task on click', async () => {
    const { onStopTask } = renderRow('in_progress', jest.fn(async () => {}));
    fireEvent.click(stopButton()!);
    // The ROW rides along with the task id: stopping from a PR row also has to
    // reconcile that row, and the handler cannot re-find it from the id alone.
    await waitFor(() =>
      expect(onStopTask).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'pr1' })),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts the reason and re-enables the button when the stop is refused', async () => {
    renderRow('in_progress', jest.fn(async () => {
      throw new Error('Task is not running');
    }));
    fireEvent.click(stopButton()!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't stop the task on acme/app#7",
        'Task is not running'
      )
    );
    expect(stopButton()).toBeEnabled();
  });

  it.each([
    ['cancelled', 'Stopped'],
    ['failed', 'Failed'],
  ] as const)('labels the badge of a %s task "%s"', (status, label) => {
    renderRow(status);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
