import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AUTO_KEEP_DEFAULT_ERROR_CODE } from '@talyn/shared';
import { api, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { useWorkspaceStore } from '../stores/workspace';
import { useBillingStore } from '../stores/billing';
import { AutoKeepToggle } from '../components/panels/github/AutoKeepToggle';

const spy = vi.spyOn.bind(vi);

afterEach(() => {
  vi.restoreAllMocks();
});
/**
 * The "Keep new PRs green" toggle in the My PRs header.
 *
 * Two things interact here. Turning it ON is an Unlimited feature and the gate
 * is on the TRANSITION — so free+off pitches, free+on is grandfathered and can
 * still be turned off, paid just works. And the FIRST time anyone turns it on,
 * an explainer stands in the way, because it commits the account to a cloud run
 * per PR opened, indefinitely.
 *
 * Duplicated in the other app on purpose: the renderer is a deliberate fork.
 */

const EXPLAINED_KEY = 'fastowl-auto-keep-explained';

function seed(opts: { plan?: 'free' | 'unlimited'; enabled?: boolean; explained?: boolean }) {
  localStorage.clear();
  if (opts.explained) localStorage.setItem(EXPLAINED_KEY, '1');
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    workspaces: [
      {
        id: 'ws1',
        name: 'ws1',
        settings: opts.enabled ? { defaultAutoKeepMergeable: true } : {},
      },
    ],
  } as never);
  useBillingStore.setState({
    status: opts.plan ? ({ plan: opts.plan } as never) : null,
    upgradeModalOpen: false,
    upgradeReason: null,
  } as never);
}

const toggle = () => document.querySelector('[data-attr="my-prs-auto-keep-toggle"]')!;
const confirmBtn = () => document.querySelector('[data-attr="auto-keep-explainer-confirm"]');

describe('AutoKeepToggle — the first-run explainer', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('explains before turning on, rather than just turning on', async () => {
    const update = spy(api.workspaces, 'update').mockResolvedValue({} as never);
    seed({ plan: 'unlimited', enabled: false });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(confirmBtn()).toBeTruthy());
    // Nothing is written until the explainer is confirmed.
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(/Only PRs you author/i)).toBeTruthy();
  });

  it('applies the change once confirmed, and remembers it was shown', async () => {
    const update = spy(api.workspaces, 'update').mockResolvedValue({} as never);
    spy(toast, 'success').mockImplementation(() => 'id');
    seed({ plan: 'unlimited', enabled: false });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(confirmBtn()).toBeTruthy());
    fireEvent.click(confirmBtn()!);

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toEqual({
      settings: { defaultAutoKeepMergeable: true },
    });
    expect(localStorage.getItem(EXPLAINED_KEY)).toBe('1');
  });

  it('does not remember a cancel — the safety net stays up', async () => {
    const update = spy(api.workspaces, 'update');
    seed({ plan: 'unlimited', enabled: false });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(confirmBtn()).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(confirmBtn()).toBeNull());
    expect(update).not.toHaveBeenCalled();
    expect(localStorage.getItem(EXPLAINED_KEY)).toBeNull();
  });

  it('skips the explainer once it has been confirmed before', async () => {
    const update = spy(api.workspaces, 'update').mockResolvedValue({} as never);
    spy(toast, 'success').mockImplementation(() => 'id');
    seed({ plan: 'unlimited', enabled: false, explained: true });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(confirmBtn()).toBeNull();
  });

  it('never explains on the way OFF — you already know what it does', async () => {
    const update = spy(api.workspaces, 'update').mockResolvedValue({} as never);
    spy(toast, 'success').mockImplementation(() => 'id');
    seed({ plan: 'unlimited', enabled: true });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toEqual({
      settings: { defaultAutoKeepMergeable: false },
    });
    expect(confirmBtn()).toBeNull();
  });

  it('explains first, then pitches, for a free plan', async () => {
    // Learning what it is should come before being asked to pay for it.
    const update = spy(api.workspaces, 'update');
    seed({ plan: 'free', enabled: false });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(confirmBtn()).toBeTruthy());
    expect(confirmBtn()!.textContent).toContain('See Unlimited');
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);

    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(useBillingStore.getState().upgradeModalOpen).toBe(true));
    expect(useBillingStore.getState().upgradeReason).toBe('auto_keep_default');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('AutoKeepToggle — the plan gate', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('pitches the upgrade instead of writing, for a free plan with it off', async () => {
    const update = spy(api.workspaces, 'update');
    seed({ plan: 'free', enabled: false, explained: true });
    render(<AutoKeepToggle />);

    expect(toggle().textContent).toContain('Unlimited');
    fireEvent.click(toggle());

    await waitFor(() => expect(useBillingStore.getState().upgradeModalOpen).toBe(true));
    expect(useBillingStore.getState().upgradeReason).toBe('auto_keep_default');
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a grandfathered free plan turn it OFF', async () => {
    // The asymmetry that makes grandfathering work: on a free plan the button
    // is a pitch when off, but a real toggle when already on.
    const update = spy(api.workspaces, 'update').mockResolvedValue({} as never);
    spy(toast, 'success').mockImplementation(() => 'id');
    seed({ plan: 'free', enabled: true, explained: true });
    render(<AutoKeepToggle />);

    expect(toggle().textContent).not.toContain('Unlimited');
    fireEvent.click(toggle());

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toEqual({
      settings: { defaultAutoKeepMergeable: false },
    });
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });

  it('reflects the enabled state to assistive tech', () => {
    seed({ plan: 'unlimited', enabled: true, explained: true });
    render(<AutoKeepToggle />);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    cleanup();
    seed({ plan: 'unlimited', enabled: false, explained: true });
    render(<AutoKeepToggle />);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('treats an unknown plan as paid rather than flashing the modal on cold start', async () => {
    // `status` is null until the first billing fetch lands. Guessing "free"
    // there would pitch an upgrade to someone who already pays.
    const update = spy(api.workspaces, 'update').mockResolvedValue({} as never);
    spy(toast, 'success').mockImplementation(() => 'id');
    seed({ enabled: false, explained: true });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });

  it('opens the modal when the server refuses a racing turn-on', async () => {
    // The plan snapshot can be stale, so the 402 is the real authority.
    spy(api.workspaces, 'update').mockRejectedValue(
      new ApiError('needs unlimited', 402, AUTO_KEEP_DEFAULT_ERROR_CODE)
    );
    seed({ plan: 'unlimited', enabled: false, explained: true });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(useBillingStore.getState().upgradeModalOpen).toBe(true));
    expect(useBillingStore.getState().upgradeReason).toBe('auto_keep_default');
  });

  it('toasts a non-billing failure without opening the modal', async () => {
    spy(api.workspaces, 'update').mockRejectedValue(new Error('network down'));
    const err = spy(toast, 'error').mockImplementation(() => 'id');
    seed({ plan: 'unlimited', enabled: false, explained: true });
    render(<AutoKeepToggle />);

    fireEvent.click(toggle());
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });
});
