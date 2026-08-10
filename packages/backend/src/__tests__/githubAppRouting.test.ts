import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { githubService } from '../services/github.js';
import { _resetInstallationTokenCache } from '../services/githubApp.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable, githubInstallations as githubInstallationsTable } from '../db/schema.js';

/**
 * Hybrid-auth routing: an App-connected workspace (one with an installationId)
 * must send a freshly-minted INSTALLATION token on data-plane reads, and the
 * USER token only on viewer-identity endpoints (`/user`). A legacy workspace
 * with no installationId keeps sending the stored token everywhere.
 */

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface Captured {
  url: string;
  authorization: string | null;
}

function capturingFetch(
  captured: Captured[],
  routes: Record<string, unknown>,
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers((init?.headers as HeadersInit) ?? {});
    captured.push({ url, authorization: headers.get('authorization') });
    for (const [pattern, payload] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`no fetch mock for ${url}`);
  });
}

describe('github hybrid-auth routing', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.GITHUB_APP_ID = '777';
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');

    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });

    _resetInstallationTokenCache();
    // Rebuild the (singleton) installation index from the fresh, empty test DB
    // so entries seeded by a prior test don't leak in.
    await githubService.refreshInstallationIndex();
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
  });

  afterEach(async () => {
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    await cleanup();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('uses the installation token for data-plane reads and the user token for /user', async () => {
    await db.insert(githubInstallationsTable).values({
      installationId: '555', accountLogin: 'acme', accountType: 'Organization',
      repoFullNames: [], createdAt: new Date(), updatedAt: new Date(),
    });
    await githubService.refreshInstallationIndex();
    await githubService.storeToken('ws1', 'ghu_usertoken', 'bearer', 'repo', {
      installationId: '555',
    });

    const captured: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      capturingFetch(captured, {
        '/app/installations/555/access_tokens': {
          token: 'ghs_installtoken',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        '/repos/acme/widget/pulls/7': { number: 7, title: 'PR' },
        '/user': { id: 1, login: 'octocat' },
      }),
    );

    await githubService.getPullRequest('ws1', 'acme', 'widget', 7);
    await githubService.getUser('ws1');

    const prCall = captured.find((c) => c.url.includes('/repos/acme/widget/pulls/7'));
    const userCall = captured.find((c) => c.url.endsWith('/user'));
    expect(prCall?.authorization).toBe('token ghs_installtoken');
    expect(userCall?.authorization).toBe('bearer ghu_usertoken');
  });

  /**
   * A SEARCH must use the installation covering the repo it searches.
   *
   * The repo lives in the `q` qualifier, not the path, and URLSearchParams
   * percent-encodes it: `q=repo%3APostHog%2Fcharts…`. ownerFromEndpoint matched
   * a literal `repo:`, so it allowed `%2F` for the slash but never got past
   * `%3A` for the colon — the owner came back undefined and every search fell
   * back to the workspace's PRIMARY installation.
   *
   * That token belongs to another account, so GitHub answers 403 "Resource not
   * accessible by integration", and prMonitor reports it as "the GitHub App has
   * no access to <repo>". The App had access all along; the request carried the
   * wrong installation's token.
   */
  it('searches with the installation that covers the searched repo, not the primary one', async () => {
    // Two installations, and the workspace's primary is the WRONG one for the
    // repo being searched.
    await db.insert(githubInstallationsTable).values([
      {
        installationId: '555', accountLogin: 'acme', accountType: 'Organization',
        repoFullNames: [], createdAt: new Date(), updatedAt: new Date(),
      },
      {
        installationId: '888', accountLogin: 'PostHog', accountType: 'Organization',
        repoFullNames: [], createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    await githubService.refreshInstallationIndex();
    await githubService.storeToken('ws1', 'ghu_usertoken', 'bearer', 'repo', {
      installationId: '555',
    });

    const captured: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      capturingFetch(captured, {
        '/app/installations/555/access_tokens': {
          token: 'ghs_acme', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        '/app/installations/888/access_tokens': {
          token: 'ghs_posthog', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        '/search/issues': { total_count: 0, items: [] },
      }),
    );

    await githubService.searchPullRequestNumbers('ws1', 'repo:PostHog/charts is:pr is:open');

    const search = captured.find((c) => c.url.includes('/search/issues'));
    expect(search).toBeTruthy();
    expect(search?.authorization).toBe('token ghs_posthog');
    // The bug: acme's token on a PostHog search.
    expect(search?.authorization).not.toBe('token ghs_acme');
  });

  it('falls back to the stored token everywhere for a workspace without an installation', async () => {
    await githubService.storeToken('ws1', 'gho_legacy', 'bearer', 'repo');

    const captured: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      capturingFetch(captured, { '/repos/acme/widget/pulls/7': { number: 7 } }),
    );

    await githubService.getPullRequest('ws1', 'acme', 'widget', 7);
    const prCall = captured.find((c) => c.url.includes('/pulls/7'));
    // No installation minting happened — the only call is the data-plane read,
    // authed with the stored OAuth token.
    expect(captured.some((c) => c.url.includes('/access_tokens'))).toBe(false);
    expect(prCall?.authorization).toBe('bearer gho_legacy');
  });

  it('resolves the installation by repo OWNER when a workspace spans accounts', async () => {
    // Two installations: acme → inst-A (the workspace's primary), beta → inst-B.
    await db.insert(githubInstallationsTable).values([
      { installationId: 'inst-A', accountLogin: 'acme', accountType: 'Organization', repoFullNames: [], createdAt: new Date(), updatedAt: new Date() },
      { installationId: 'inst-B', accountLogin: 'beta', accountType: 'Organization', repoFullNames: [], createdAt: new Date(), updatedAt: new Date() },
    ]);
    await githubService.refreshInstallationIndex();
    await githubService.storeToken('ws1', 'ghu_usertoken', 'bearer', 'repo', { installationId: 'inst-A' });

    const captured: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      capturingFetch(captured, {
        '/app/installations/inst-A/access_tokens': { token: 'ghs_A', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        '/app/installations/inst-B/access_tokens': { token: 'ghs_B', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        '/repos/acme/widget/pulls/1': { number: 1 },
        '/repos/beta/gadget/pulls/2': { number: 2 },
      }),
    );

    await githubService.getPullRequest('ws1', 'acme', 'widget', 1);
    await githubService.getPullRequest('ws1', 'beta', 'gadget', 2);

    // acme repo → inst-A token; beta repo → inst-B token (resolved by owner).
    expect(captured.find((c) => c.url.includes('/repos/acme/widget'))?.authorization).toBe('token ghs_A');
    expect(captured.find((c) => c.url.includes('/repos/beta/gadget'))?.authorization).toBe('token ghs_B');
  });
});
