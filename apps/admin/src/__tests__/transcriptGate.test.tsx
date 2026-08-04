import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AdminTaskDetail } from '@talyn/shared';

/**
 * A customer's agent transcript is never fetched by accident.
 *
 * The backend writes an audit row every time it serves one, and that is what
 * makes showing it defensible at all. If the page fetched it on mount, the log
 * would fill with accesses nobody chose to make — burying the ones somebody
 * did, and turning a deliberate record into noise.
 *
 * So the property here is narrow and worth pinning exactly: opening a task
 * requests it WITHOUT the transcript, and the request that includes it happens
 * only after an explicit click.
 */

const get = vi.fn();
vi.mock('../lib/api', () => ({
  api: { admin: { tasks: { get: (...a: unknown[]) => get(...a) } } },
}));

const { TaskDetailPage } = await import('../routes/product/TaskDetailPage');

function task(overrides: Partial<AdminTaskDetail> = {}): AdminTaskDetail {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    ownerEmail: 'customer@example.test',
    type: 'code_writing',
    status: 'completed',
    title: 'Fix the thing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    provider: 'selfhosted',
    remoteRunId: 'talyn-1',
    cloudStatus: 'completed',
    fleetHost: 'hetzner-64',
    phase: null,
    costUsd: 0.5,
    prompt: 'do the thing',
    repositoryId: null,
    branch: null,
    error: null,
    prUrl: null,
    transcript: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/product/tasks/task-1']}>
      <Routes>
        <Route path="/product/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(task());
});
afterEach(cleanup);

describe('the transcript is behind a click', () => {
  it('does not request the transcript on mount', async () => {
    renderPage();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get).toHaveBeenCalledWith('task-1', { transcript: false });
    // Not once, with any argument, anywhere.
    for (const call of get.mock.calls) {
      expect(call[1]).toEqual({ transcript: false });
    }
  });

  it('tells the operator that opening it is recorded', async () => {
    // The consent is informed or it is not consent.
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/recorded in the audit log/i)
    );
  });

  it('requests it only after the explicit click', async () => {
    renderPage();
    await waitFor(() => expect(document.body.textContent).toMatch(/Show transcript/i));
    screen.getByText(/Show transcript/i).click();
    await waitFor(() => expect(get).toHaveBeenCalledWith('task-1', { transcript: true }));
  });

  it('renders the transcript once fetched', async () => {
    renderPage();
    await waitFor(() => expect(document.body.textContent).toMatch(/Show transcript/i));
    get.mockResolvedValue(task({ transcript: [{ type: 'text', text: 'CUSTOMER CONVERSATION' }] }));
    screen.getByText(/Show transcript/i).click();
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/CUSTOMER CONVERSATION/)
    );
  });

  it('says so plainly when there is no transcript, rather than looking broken', async () => {
    renderPage();
    await waitFor(() => expect(document.body.textContent).toMatch(/Show transcript/i));
    get.mockResolvedValue(task({ transcript: [] }));
    screen.getByText(/Show transcript/i).click();
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/has no transcript/i)
    );
  });
});
