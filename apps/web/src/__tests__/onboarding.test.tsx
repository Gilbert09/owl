import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * The onboarding wizard renders in the browser build.
 *
 * It cannot be reached by hand on an account that already has a workspace —
 * useInitialDataLoad's migration correctly flips onboardingComplete for
 * returning users, exactly as on the desktop — so this is how the web port
 * gets exercised at all.
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
  it('renders step one of three', () => {
    render(<OnboardingWizard />);
    const body = document.body.textContent ?? '';
    expect(body).toContain('Welcome to Talyn');
    // Only the CURRENT step's title is shown; the rail is numbered.
    expect(screen.getByText('Name your workspace')).toBeTruthy();
    expect(body).toContain('Workspace name');
    expect(body).toMatch(/1\s*2\s*3|123/);
  });

  it('starts on step one and gates progress', () => {
    render(<OnboardingWizard />);
    const next = [...document.querySelectorAll('button')].find((b) =>
      /next|continue/i.test(b.textContent ?? '')
    );
    // Step 1 needs a workspace before it will advance.
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
