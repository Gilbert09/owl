import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import type { ReleaseHighlight, ReleaseNoteEntry } from '@talyn/shared';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useWhatsNew, LAST_SEEN_KEY } from '../hooks/useWhatsNew';
import { WhatsNewModal } from '../components/modals/WhatsNewModal';

/**
 * The "What's new" modal and the launch-time check that decides whether to
 * open it.
 *
 * The interesting cases are all about NOT showing it: a first run, a nightly
 * with nothing user-facing, a release whose highlights were all for the other
 * client, and a second mount. Getting any of those wrong means a modal in
 * front of a user who has nothing to read.
 *
 * The one thing this app does NOT do is cap by version. app.talyn.dev is
 * continuously deployed, so it is always at or ahead of the newest cut release
 * — the desktop's "don't show me a release I haven't installed" ceiling has
 * nothing to protect against here, and its build id (`web/<sha>`) has no order
 * to compare with anyway.
 *
 * Duplicated in the other app on purpose: the renderer is a deliberate fork.
 */

const highlight = (over: Partial<ReleaseHighlight> = {}): ReleaseHighlight => ({
  title: 'Watch a PR you did not write',
  description: 'Paste a pull request URL to track its checks alongside your own.',
  kind: 'feature',
  surfaces: ['desktop', 'web'],
  ...over,
});

const entry = (
  version: string,
  highlights: ReleaseHighlight[] = [highlight()]
): ReleaseNoteEntry => ({
  version,
  publishedAt: '2026-08-30T03:00:00.000Z',
  highlights,
});

function Harness() {
  useWhatsNew();
  return <WhatsNewModal />;
}

function seed(lastSeen: string | null, opts: { justOnboarded?: boolean } = {}) {
  localStorage.clear();
  if (lastSeen) localStorage.setItem(LAST_SEEN_KEY, lastSeen);
  useWorkspaceStore.setState({
    whatsNewOpen: false,
    whatsNewEntries: [],
    whatsNewChecked: false,
    justOnboarded: Boolean(opts.justOnboarded),
  } as never);
}

// The title uses a typographic apostrophe (&rsquo;), so match loosely.
const modalOpen = () => Boolean(screen.queryByText(/What.s new/));
const stored = () => localStorage.getItem(LAST_SEEN_KEY);

describe('useWhatsNew — deciding whether to interrupt', () => {
  let list: MockInstance;
  let latest: MockInstance;

  beforeEach(() => {
    list = vi.spyOn(api.releaseNotes, 'list').mockResolvedValue([]);
    latest = vi.spyOn(api.releaseNotes, 'latest').mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows nothing on a first run and records the latest release as the baseline', async () => {
    seed(null);
    latest.mockResolvedValue(entry('0.2.62'));

    render(<Harness />);

    await waitFor(() => expect(stored()).toBe('0.2.62'));
    expect(latest).toHaveBeenCalled();
    // A brand-new user gets the app, not a changelog of everything that shipped.
    expect(list).not.toHaveBeenCalled();
    expect(modalOpen()).toBe(false);
  });

  it('opens for releases the user has not seen', async () => {
    seed('0.2.60');
    list.mockResolvedValue([entry('0.2.61'), entry('0.2.62')]);

    render(<Harness />);

    await waitFor(() => expect(modalOpen()).toBe(true));
    expect(list).toHaveBeenCalledWith('0.2.60');
    // Both releases are rendered, each with its own heading.
    expect(screen.getAllByText('Watch a PR you did not write')).toHaveLength(2);
    expect(screen.getByText('Version 0.2.62')).toBeTruthy();
    expect(screen.getByText('Version 0.2.61')).toBeTruthy();
    expect(stored()).toBe('0.2.62');
  });

  it('stays shut for a nightly that carried nothing user-facing, but still records it', async () => {
    seed('0.2.60');
    list.mockResolvedValue([entry('0.2.61', [])]);

    render(<Harness />);

    // Recording it is the point: otherwise this release is re-fetched and
    // re-evaluated on every single launch, forever.
    await waitFor(() => expect(stored()).toBe('0.2.61'));
    expect(modalOpen()).toBe(false);
  });

  it('ignores highlights that only apply to the desktop app, and records them anyway', async () => {
    seed('0.2.60');
    list.mockResolvedValue([entry('0.2.61', [highlight({ surfaces: ['desktop'] })])]);

    render(<Harness />);

    await waitFor(() => expect(stored()).toBe('0.2.61'));
    expect(modalOpen()).toBe(false);
  });

  it('applies no version ceiling — every published release is already live here', async () => {
    seed('0.2.60');
    list.mockResolvedValue([entry('0.2.61'), entry('0.2.62'), entry('0.2.63')]);

    render(<Harness />);

    await waitFor(() => expect(modalOpen()).toBe(true));
    expect(screen.getByText('Version 0.2.63')).toBeTruthy();
    expect(stored()).toBe('0.2.63');
  });

  it('does not fire for a user who just finished onboarding', async () => {
    seed(null, { justOnboarded: true });

    render(<Harness />);

    await waitFor(() => expect(useWorkspaceStore.getState().whatsNewChecked).toBe(false));
    expect(latest).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('checks once, however many times the layout remounts', async () => {
    // MainLayout is re-rendered per route in the web fork, so the guard has to
    // live in the store rather than in component state.
    seed('0.2.60');
    list.mockResolvedValue([entry('0.2.61')]);

    const first = render(<Harness />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<Harness />);
    await waitFor(() => expect(useWorkspaceStore.getState().whatsNewChecked).toBe(true));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the backend is unreachable, so the next launch retries', async () => {
    seed('0.2.60');
    list.mockRejectedValue(new Error('offline'));

    render(<Harness />);

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(stored()).toBe('0.2.60');
    expect(modalOpen()).toBe(false);
  });
});

describe('WhatsNewModal — rendering', () => {
  afterEach(cleanup);

  it('stamps each release with its version when several are shown at once', () => {
    useWorkspaceStore.setState({
      whatsNewOpen: true,
      whatsNewEntries: [entry('0.2.62'), entry('0.2.61')],
    } as never);

    render(<WhatsNewModal />);

    expect(screen.getByText('Version 0.2.62')).toBeTruthy();
    expect(screen.getByText('Version 0.2.61')).toBeTruthy();
    expect(screen.getByText(/across 2 releases/)).toBeTruthy();
  });

  it('puts a single release in the subtitle instead of a heading', () => {
    useWorkspaceStore.setState({
      whatsNewOpen: true,
      whatsNewEntries: [entry('0.2.62')],
    } as never);

    render(<WhatsNewModal />);

    expect(screen.getByText(/Version 0\.2\.62, released/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Version 0.2.62' })).toBeNull();
  });

  it('closes on the button and on Escape', async () => {
    useWorkspaceStore.setState({
      whatsNewOpen: true,
      whatsNewEntries: [entry('0.2.62')],
    } as never);

    const view = render(<WhatsNewModal />);
    fireEvent.click(screen.getByText('Got it'));
    expect(useWorkspaceStore.getState().whatsNewOpen).toBe(false);

    // ui/dialog is hand-rolled, so Escape is the modal's own responsibility.
    useWorkspaceStore.setState({ whatsNewOpen: true } as never);
    view.rerender(<WhatsNewModal />);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(useWorkspaceStore.getState().whatsNewOpen).toBe(false));
  });
});
