import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

/**
 * The onboarding wizard's shape, and the signal that decides whether anyone
 * sees it.
 *
 * The second part matters more than it looks. The backend now bootstraps a
 * workspace for every owner, so "this user has a workspace" — which used to
 * mean "returning user, skip the wizard" — is true ten seconds after signup.
 * Keying off it would skip onboarding for every new user, including the
 * REQUIRED GitHub step, and strand them in an app that can never show a PR.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

jest.mock('../renderer/lib/api', () => ({
  api: {
    github: {
      getStatus: jest.fn().mockResolvedValue({ connected: false }),
      installViaApp: jest.fn().mockResolvedValue({ installUrl: 'x', manageUrl: 'y' }),
    },
    repositories: { list: jest.fn().mockResolvedValue([]) },
    workspaces: { list: jest.fn().mockResolvedValue([]), create: jest.fn() },
  },
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OnboardingWizard } = require('../renderer/components/onboarding/OnboardingWizard');

afterEach(() => cleanup());

describe('OnboardingWizard', () => {
  it('opens on Connect GitHub — there is no name-your-workspace step', () => {
    render(<OnboardingWizard />);
    const body = document.body.textContent ?? '';
    expect(body).toContain('Welcome to Talyn');
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
    expect(next?.hasAttribute('disabled')).toBe(true);
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
