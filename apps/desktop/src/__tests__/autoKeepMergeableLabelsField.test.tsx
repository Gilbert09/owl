import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { Workspace } from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { toast } from '../renderer/stores/toast';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { AutoKeepMergeableLabelsField } from '../renderer/components/panels/SettingsPanel';

/**
 * The "Label watched PRs" field commits on blur or Enter, sends the parsed
 * list (not the raw text), and leaves the store alone when nothing changed.
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

function workspace(labels?: string[]): Workspace {
  return {
    id: 'ws1',
    name: 'ws',
    repos: [],
    integrations: {},
    settings: labels ? { autoKeepMergeableLabels: labels } : {},
    createdAt: '',
    updatedAt: '',
  };
}

function seed(labels?: string[]) {
  useWorkspaceStore.setState({ workspaces: [workspace(labels)], currentWorkspaceId: 'ws1' });
}

const input = () => screen.getByPlaceholderText(/auto-review/) as HTMLInputElement;

let update: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  update = jest.spyOn(api.workspaces, 'update').mockResolvedValue(workspace());
  error = jest.spyOn(toast, 'error').mockImplementation(() => 'id');
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('AutoKeepMergeableLabelsField', () => {
  it('shows the saved labels comma-separated', () => {
    seed(['auto-review', 'stamp']);
    render(<AutoKeepMergeableLabelsField />);
    expect(input().value).toBe('auto-review, stamp');
  });

  it.each([
    { name: 'blur', fire: () => fireEvent.blur(input()) },
    { name: 'Enter', fire: () => fireEvent.keyDown(input(), { key: 'Enter' }) },
  ])('saves the parsed list on $name and updates the store', async ({ fire }) => {
    seed();
    render(<AutoKeepMergeableLabelsField />);
    input().focus();
    fireEvent.change(input(), { target: { value: ' auto-review,, Stamp , stamp' } });
    fire();

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('ws1', {
      settings: { autoKeepMergeableLabels: ['auto-review', 'Stamp'] },
    });
    await waitFor(() => expect(input().value).toBe('auto-review, Stamp'));
    expect(useWorkspaceStore.getState().workspaces[0].settings.autoKeepMergeableLabels).toEqual([
      'auto-review',
      'Stamp',
    ]);
  });

  it.each([
    { name: 'untouched', typed: 'auto-review, stamp' },
    { name: 'only whitespace and casing-insensitive duplicates', typed: 'auto-review ,stamp, STAMP' },
  ])('does not save when the parsed list is unchanged ($name)', async ({ typed }) => {
    seed(['auto-review', 'stamp']);
    render(<AutoKeepMergeableLabelsField />);
    fireEvent.change(input(), { target: { value: typed } });
    fireEvent.blur(input());

    await waitFor(() => expect(input().value).toBe('auto-review, stamp'));
    expect(update).not.toHaveBeenCalled();
  });

  it('clearing the field saves an empty list', async () => {
    seed(['auto-review']);
    render(<AutoKeepMergeableLabelsField />);
    fireEvent.change(input(), { target: { value: '  ' } });
    fireEvent.blur(input());

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('ws1', { settings: { autoKeepMergeableLabels: [] } });
  });

  it('a failed save toasts and puts the saved value back', async () => {
    seed(['auto-review']);
    update.mockRejectedValue(new Error('nope'));
    render(<AutoKeepMergeableLabelsField />);
    fireEvent.change(input(), { target: { value: 'stamp' } });
    fireEvent.blur(input());

    await waitFor(() => expect(error).toHaveBeenCalledWith('nope'));
    expect(input().value).toBe('auto-review');
    expect(useWorkspaceStore.getState().workspaces[0].settings.autoKeepMergeableLabels).toEqual([
      'auto-review',
    ]);
  });

  it('is disabled without a current workspace', () => {
    useWorkspaceStore.setState({ workspaces: [], currentWorkspaceId: null });
    render(<AutoKeepMergeableLabelsField />);
    expect(input().disabled).toBe(true);
  });
});
