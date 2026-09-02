import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import type { ReleaseHighlight, ReleaseNoteEntry } from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWhatsNew, LAST_SEEN_KEY } from '../renderer/hooks/useWhatsNew';
import { WhatsNewModal } from '../renderer/components/modals/WhatsNewModal';

/**
 * The "What's new" modal and the launch-time check that decides whether to
 * open it.
 *
 * The interesting cases are all about NOT showing it: a first run, a nightly
 * with nothing user-facing, a release the running build hasn't installed yet,
 * and a second mount. Getting any of those wrong means a modal in front of a
 * user who has nothing to read.
 *
 * Duplicated in the other app on purpose: the renderer is a deliberate fork.
 */

const APP_VERSION = '0.2.62';

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
  let list: jest.SpyInstance;
  let latest: jest.SpyInstance;

  beforeEach(() => {
    process.env.TALYN_APP_VERSION = APP_VERSION;
    list = jest.spyOn(api.releaseNotes, 'list').mockResolvedValue([]);
    latest = jest.spyOn(api.releaseNotes, 'latest').mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    delete process.env.TALYN_APP_VERSION;
  });

  // A missing key does NOT mean "new install". It also means "first run of a
  // build that has this feature" — which was every user Talyn already had, and
  // baselining them silently is why the first release's notes reached nobody.
  it('catches an existing user up on the release they just updated into', async () => {
    seed(null);
    list.mockResolvedValue([entry(APP_VERSION), entry('0.2.61')]);

    render(<Harness />);

    await waitFor(() => expect(modalOpen()).toBe(true));
    expect(stored()).toBe(APP_VERSION);
  });

  it('catches them up on that ONE release, not the whole table', async () => {
    // Replaying months of releases at someone who was using the app the whole
    // time is not "what's new", and that modal would grow without bound.
    seed(null);
    list.mockResolvedValue([entry(APP_VERSION), entry('0.2.61'), entry('0.2.60')]);

    render(<Harness />);

    await waitFor(() => expect(modalOpen()).toBe(true));
    expect(useWorkspaceStore.getState().whatsNewEntries.map((e) => e.version)).toEqual([
      APP_VERSION,
    ]);
  });

  it('still shows nothing when that release had nothing worth reading', async () => {
    seed(null);
    list.mockResolvedValue([entry(APP_VERSION, [])]);

    render(<Harness />);

    await waitFor(() => expect(stored()).toBe(APP_VERSION));
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
    expect(screen.getByText('Version 0.2.62')).toBeInTheDocument();
    expect(screen.getByText('Version 0.2.61')).toBeInTheDocument();
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

  it('ignores highlights that only apply to the web app, and records them anyway', async () => {
    seed('0.2.60');
    list.mockResolvedValue([entry('0.2.61', [highlight({ surfaces: ['web'] })])]);

    render(<Harness />);

    await waitFor(() => expect(stored()).toBe('0.2.61'));
    expect(modalOpen()).toBe(false);
  });

  it('never shows — or records — a release newer than the running build', async () => {
    seed('0.2.60');
    // CI published 0.2.63 tonight; this user is still on 0.2.62.
    list.mockResolvedValue([entry('0.2.61'), entry('0.2.62'), entry('0.2.63')]);

    render(<Harness />);

    await waitFor(() => expect(modalOpen()).toBe(true));
    expect(screen.getByText('Version 0.2.62')).toBeInTheDocument();
    expect(screen.queryByText('Version 0.2.63')).not.toBeInTheDocument();
    // Recording 0.2.63 would swallow its notes after the update lands.
    expect(stored()).toBe('0.2.62');
  });

  it('does nothing at all on a local build, whose version is not a semver', async () => {
    process.env.TALYN_APP_VERSION = 'dev';
    seed('0.2.60');
    list.mockResolvedValue([entry('0.2.61')]);

    render(<Harness />);

    // Without a version there is no way to tell which releases this build
    // contains, so it neither shows nor records anything. Settings → About is
    // how you look at the modal on a dev machine.
    await waitFor(() => expect(useWorkspaceStore.getState().whatsNewChecked).toBe(true));
    expect(list).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    expect(modalOpen()).toBe(false);
    expect(stored()).toBe('0.2.60');
  });

  it('baselines a user who just finished onboarding, and shows them nothing', async () => {
    // They installed minutes ago; nothing in the feed is new to them. They are
    // also the reason the catch-up above can be unconditional — a genuinely
    // new user is baselined HERE and so never reaches it.
    seed(null, { justOnboarded: true });
    latest.mockResolvedValue(entry('0.2.62'));

    render(<Harness />);

    await waitFor(() => expect(stored()).toBe('0.2.62'));
    expect(list).not.toHaveBeenCalled();
    expect(modalOpen()).toBe(false);
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

    expect(screen.getByText('Version 0.2.62')).toBeInTheDocument();
    expect(screen.getByText('Version 0.2.61')).toBeInTheDocument();
    expect(screen.getByText(/across 2 releases/)).toBeInTheDocument();
  });

  it('puts a single release in the subtitle instead of a heading', () => {
    useWorkspaceStore.setState({
      whatsNewOpen: true,
      whatsNewEntries: [entry('0.2.62')],
    } as never);

    render(<WhatsNewModal />);

    expect(screen.getByText(/Version 0\.2\.62, released/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Version 0.2.62' })).not.toBeInTheDocument();
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
