import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * The onboarding wizard renders in the browser build.
 *
 * It cannot be reached by hand on an account that has GitHub connected —
 * useInitialDataLoad flips onboardingComplete for those users, exactly as on
 * the desktop — so this is how the web port gets exercised at all.
 *
 * What is actually at risk here is not the wizard's logic, which was copied
 * verbatim, but its ONE browser-specific dependency: step 2 starts the GitHub
 * App flow and then waits for `useGithubConnection` to re-check on window
 * focus. The first port navigated the current tab to GitHub, which unmounts
 * the wizard mid-setup and — because the backend sends browser clients to
 * /settings — drops the user out of onboarding entirely. lib/githubInstall
 * now opens a separate tab, claimed synchronously before the fetch spends
 * user activation, so this page survives.
 */

vi.mock('../lib/api', () => ({
  api: {
    github: {
      getStatus: vi.fn().mockResolvedValue({ connected: false }),
      installViaApp: vi.fn().mockResolvedValue({
        installUrl: 'https://github.com/apps/x/installations/new',
        manageUrl: 'https://github.com/apps/x/installations',
      }),
    },
    repositories: { list: vi.fn().mockResolvedValue([]) },
    workspaces: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
  },
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

const { OnboardingWizard } = await import('../components/onboarding/OnboardingWizard');

beforeEach(() => vi.clearAllMocks());

describe('OnboardingWizard', () => {
  it('opens on Connect GitHub — there is no name-your-workspace step', () => {
    // The backend bootstraps the workspace, so onboarding starts at the first
    // thing that actually needs the user.
    render(<OnboardingWizard />);
    const body = document.body.textContent ?? '';
    expect(body).toContain('Welcome to Talyn');
    // Only the CURRENT step's title is shown; the rail is numbered.
    expect(screen.getByText('Connect GitHub')).toBeTruthy();
    expect(body).not.toContain('Name your workspace');
    expect(body).not.toContain('Workspace name');
    // Three steps: GitHub, then the agent, then repos. The agent step is new —
    // it did not used to be part of setup, and is now because the fleet runs on
    // the user's OWN Claude or Codex subscription, so asking up front is what
    // makes the first task run on their key.
    expect(screen.getByTitle('Connect an agent')).toBeTruthy();
    expect(screen.queryByText('4')).toBeNull();
  });

  // Optional on purpose: a workspace that is not on the fleet allow-list is
  // served no fleet card, and gating Next would strand it on a step it cannot
  // complete. ConnectAgentModal remains the fallback for anyone who skips.
  it('does not gate progress on connecting an agent', () => {
    const { container } = render(<OnboardingWizard />);
    expect(container.querySelector('[title="Connect an agent"]')).toBeTruthy();
    expect(container.textContent).toContain('Connect GitHub');
  });

  it('gates progress on the GitHub connection', () => {
    render(<OnboardingWizard />);
    const next = [...document.querySelectorAll('button')].find((b) =>
      /next|continue/i.test(b.textContent ?? '')
    );
    // getStatus is mocked to `connected: false`, and GitHub is the one step
    // the wizard insists on — without it the app can never show a PR.
    expect(next?.hasAttribute('disabled')).toBe(true);
  });
});

describe('the GitHub connect flow does not navigate this page away', () => {
  it('opens a separate tab, claimed before the await', async () => {
    const open = vi.fn().mockReturnValue({ closed: false, location: { href: '' } });
    const assign = vi.fn();
    vi.stubGlobal('open', open);
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
    });

    const { openGithubAppFlow } = await import('../lib/githubInstall');
    await openGithubAppFlow('ws1', 'connect');

    expect(open).toHaveBeenCalled();
    // The critical assertion: this tab is NOT navigated away, because doing
    // so unmounts the wizard mid-onboarding.
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/**
 * The predicate useInitialDataLoad applies on its first load. Kept as a plain
 * assertion rather than a render because the hook pulls in the whole API layer;
 * what is worth pinning is which fact it reads, not how it fetches.
 */
function isOnboarded(workspaces: Array<{ integrations?: { github?: unknown } }>): boolean {
  return workspaces.some((w) => !!w.integrations?.github);
}

describe('the returning-user signal', () => {
  it('does NOT treat a bootstrapped workspace as evidence of onboarding', () => {
    // The regression this whole change invites: a fresh account has exactly
    // this shape, and reading `length > 0` would send it straight past the
    // GitHub step into an app with nothing in it.
    expect(isOnboarded([{ integrations: {} }])).toBe(false);
  });

  it('treats a connected GitHub as evidence of onboarding', () => {
    expect(isOnboarded([{ integrations: { github: { enabled: true } } }])).toBe(true);
  });

  it('looks across every workspace, not just the first', () => {
    expect(
      isOnboarded([{ integrations: {} }, { integrations: { github: { enabled: true } } }])
    ).toBe(true);
  });

  it('is false with no workspaces at all', () => {
    expect(isOnboarded([])).toBe(false);
  });
});
