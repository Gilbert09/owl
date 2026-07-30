import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ApiNetworkError } from '@talyn/client';
import { useWorkspaceStore } from '../stores/workspace';
import { SystemStatusBanner } from '../components/layout/SystemStatusBanner';

/**
 * What the banner says when the backend cannot be reached.
 *
 * useGithubConnection used to catch EVERY failure — including "there is no
 * network" — and record `{ configured: false }`. The banner reads that as the
 * backend having answered, so a dropped connection surfaced as:
 *
 *   "GitHub OAuth isn't configured on the backend — PR tracking is
 *    unavailable until GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set."
 *
 * which is alarming, actionable-looking, and wrong. A transport failure means
 * we never got an answer; it is not an answer.
 */

vi.mock('../lib/githubInstall', () => ({
  openGithubAppFlow: vi.fn(),
  uncoveredOwners: () => [],
  formatOwnerList: (o: string[]) => o.join(', '),
}));

const text = () => document.body.textContent ?? '';

beforeEach(() => {
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    githubStatus: null,
    githubInstallations: null,
    repositories: [],
    backendReachable: null,
  });
});

describe('backend unreachable', () => {
  it('says it cannot reach Talyn, and never blames GitHub config', () => {
    useWorkspaceStore.setState({ backendReachable: false });
    render(<SystemStatusBanner />);
    expect(text()).toMatch(/Can't reach Talyn|You're offline/);
    expect(text()).not.toMatch(/GITHUB_CLIENT_ID/);
    expect(text()).not.toMatch(/isn't configured/);
  });

  it('suppresses the GitHub rows entirely — that state is unknown, not false', () => {
    useWorkspaceStore.setState({
      backendReachable: false,
      // A stale "disconnected" left over from before the outage must not be
      // presented as current.
      githubStatus: { configured: true, connected: false },
    });
    render(<SystemStatusBanner />);
    expect(text()).not.toMatch(/GitHub isn't connected/);
    expect(text()).toMatch(/Can't reach Talyn|You're offline/);
  });
});

describe('backend reachable', () => {
  it('still reports a genuinely unconfigured backend', () => {
    useWorkspaceStore.setState({
      backendReachable: true,
      githubStatus: { configured: false, connected: false },
    });
    render(<SystemStatusBanner />);
    expect(text()).toMatch(/GITHUB_CLIENT_ID/);
  });

  it('still reports a genuinely disconnected workspace', () => {
    useWorkspaceStore.setState({
      backendReachable: true,
      githubStatus: { configured: true, connected: false },
    });
    render(<SystemStatusBanner />);
    expect(text()).toMatch(/GitHub isn't connected/);
  });

  it('renders nothing when everything is healthy', () => {
    useWorkspaceStore.setState({
      backendReachable: true,
      githubStatus: { configured: true, connected: true },
      githubInstallations: [],
    });
    const { container } = render(<SystemStatusBanner />);
    expect(container.textContent).toBe('');
  });
});

describe('ApiNetworkError is the signal', () => {
  it('is thrown for a transport failure and carries the online state', () => {
    const err = new ApiNetworkError('GET', '/github/status', new TypeError('Failed to fetch'));
    expect(err).toBeInstanceOf(ApiNetworkError);
    expect(err.message).toMatch(/Could not reach backend/);
    expect(typeof err.online).toBe('boolean');
  });
});
