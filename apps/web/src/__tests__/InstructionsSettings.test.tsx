import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { DEFAULT_MERGEABLE_TEMPLATE, defaultPromptTemplateHash, type Workspace } from '@talyn/shared';
import { InstructionsSettings } from '../components/panels/InstructionsSettings';

const { mockUpdate, setWorkspaces, state } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  setWorkspaces: vi.fn(),
  state: { workspaces: [] as Workspace[], prRows: [] as unknown[] },
}));
vi.mock('../lib/api', () => ({
  api: { workspaces: { update: (...args: unknown[]) => mockUpdate(...args) } },
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ workspaces: state.workspaces, currentWorkspaceId: 'ws1', setWorkspaces }),
}));
vi.mock('../stores/pullRequests', () => ({
  usePullRequestStore: (selector: (s: unknown) => unknown) => selector({ rows: state.prRows }),
}));

function workspace(settings: Workspace['settings'] = {}): Workspace {
  return { id: 'ws1', name: 'WS', settings } as unknown as Workspace;
}

beforeEach(() => {
  state.workspaces = [workspace()];
  state.prRows = [];
  mockUpdate.mockImplementation(async (_id: string, data: { settings: Workspace['settings'] }) =>
    workspace({
      ...state.workspaces[0].settings,
      prompts: { ...state.workspaces[0].settings.prompts, ...data.settings.prompts },
    })
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openEditor(label = 'Keep mergeable / Fix PR') {
  const card = screen.getByText(label).closest('[class*="p-4"]') as HTMLElement;
  fireEvent.click(within(card).getByRole('button', { name: /Customize|Edit/ }));
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

describe('InstructionsSettings', () => {
  it('lists both prompts as Default with a Customize action', () => {
    render(<InstructionsSettings />);
    expect(screen.getByText('Keep mergeable / Fix PR')).toBeTruthy();
    expect(screen.getByText('Skill runs')).toBeTruthy();
    expect(screen.getAllByText('Default')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Customize' })).toHaveLength(2);
  });

  it('opens the editor pre-filled with the shipped default and a variable legend', () => {
    render(<InstructionsSettings />);
    const textarea = openEditor();
    expect(textarea.value).toBe(DEFAULT_MERGEABLE_TEMPLATE);
    expect(screen.getByTitle('Insert {{gitRules}}')).toBeTruthy();
    expect(screen.getByTitle('Insert {{loopRules}}')).toBeTruthy();
    expect(screen.queryByTitle('Insert {{skill.content}}')).toBeNull();
    expect(screen.getByText('Ready to save.')).toBeTruthy();
  });

  it('inserts a clicked variable at the caret', () => {
    render(<InstructionsSettings />);
    const textarea = openEditor();
    fireEvent.change(textarea, { target: { value: 'Fix  now\n{{gitRules}} {{pr.url}}' } });
    textarea.setSelectionRange(4, 4);
    fireEvent.click(screen.getByTitle('Insert {{pr.ref}}'));
    expect(textarea.value).toBe('Fix {{pr.ref}} now\n{{gitRules}} {{pr.url}}');
    expect(textarea.selectionStart).toBe('Fix {{pr.ref}}'.length);
  });

  it('flags a missing required variable and blocks saving', () => {
    render(<InstructionsSettings />);
    const textarea = openEditor();
    fireEvent.change(textarea, { target: { value: 'Just fix {{pr.url}} please' } });
    expect(screen.getByText(/Missing required variable/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save as workspace prompt' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves the template with the current default hash and updates the store', async () => {
    render(<InstructionsSettings />);
    const textarea = openEditor();
    fireEvent.change(textarea, { target: { value: 'Custom {{pr.url}}\n{{gitRules}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as workspace prompt' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const [id, data] = mockUpdate.mock.calls[0] as [string, { settings: { prompts: Record<string, { template: string; basedOnHash: string; updatedAt: string }> } }];
    expect(id).toBe('ws1');
    expect(data.settings.prompts.mergeable.template).toBe('Custom {{pr.url}}\n{{gitRules}}');
    expect(data.settings.prompts.mergeable.basedOnHash).toBe(defaultPromptTemplateHash('mergeable'));
    expect(typeof data.settings.prompts.mergeable.updatedAt).toBe('string');
    await waitFor(() => expect(setWorkspaces).toHaveBeenCalled());
  });

  it('previews the rendered prompt against a sample PR when none are tracked', () => {
    render(<InstructionsSettings />);
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText(/Sample PR \(no tracked PRs yet\)/)).toBeTruthy();
    expect(screen.getByText(/https:\/\/github.com\/acme\/widgets\/pull\/128/)).toBeTruthy();
  });

  it('re-renders the preview for the chosen provider', () => {
    render(<InstructionsSettings />);
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText(/git_signed_commit/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Preview provider'), { target: { value: 'selfhosted' } });
    expect(screen.getByText(/fleet-publish/)).toBeTruthy();
    expect(screen.queryByText(/git_signed_commit/)).toBeNull();
  });

  it('marks a variable as in use once the template references it', () => {
    render(<InstructionsSettings />);
    const textarea = openEditor();
    fireEvent.change(textarea, { target: { value: '{{pr.url}} {{gitRules}}' } });
    expect(within(screen.getByTitle('Insert {{pr.title}}')).queryByLabelText('In use')).toBeNull();
    fireEvent.click(screen.getByTitle('Insert {{pr.title}}'));
    expect(within(screen.getByTitle('Insert {{pr.title}}')).getByLabelText('In use')).toBeTruthy();
  });

  it('keeps Save disabled until an existing override is edited', () => {
    state.workspaces = [
      workspace({
        prompts: {
          mergeable: {
            template: 'Mine {{pr.url}} {{gitRules}}',
            basedOnHash: defaultPromptTemplateHash('mergeable'),
            updatedAt: '2026-08-01T00:00:00Z',
          },
        },
      }),
    ];
    render(<InstructionsSettings />);
    const textarea = openEditor();
    const save = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: 'Mine {{pr.url}} {{gitRules}} and more' } });
    expect(save.disabled).toBe(false);
  });

  it('shows a customized prompt with Reset, and reset sends null for that kind', async () => {
    state.workspaces = [
      workspace({
        prompts: { mergeable: { template: 'Mine {{pr.url}} {{gitRules}}', basedOnHash: '00000000', updatedAt: '2026-08-01T00:00:00Z' } },
      }),
    ];
    render(<InstructionsSettings />);
    expect(screen.getByText('Customized')).toBeTruthy();
    expect(screen.getByText(/default for this prompt changed since you customized it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0][1]).toEqual({ settings: { prompts: { mergeable: null } } });
  });

  it('the Default tab can copy the shipped text back into the editor', () => {
    state.workspaces = [
      workspace({
        prompts: { mergeable: { template: 'Mine {{pr.url}} {{gitRules}}', basedOnHash: '00000000', updatedAt: '2026-08-01T00:00:00Z' } },
      }),
    ];
    render(<InstructionsSettings />);
    const textarea = openEditor();
    expect(textarea.value).toBe('Mine {{pr.url}} {{gitRules}}');
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy into editor' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(DEFAULT_MERGEABLE_TEMPLATE);
  });
});
