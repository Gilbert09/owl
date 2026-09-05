import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  ACTIVE_STATUSES,
  resolvePostHogEnvId,
  resolveCloudEnvId,
  linkedTaskStatus,
  startPrMergeableRun,
} from '../services/prCloudFix.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  integrations as integrationsTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
} from '../db/schema.js';
import { encryptString } from '../services/tokenCrypto.js';
import { registerCloudProvider } from '../services/cloudProviders/registry.js';
import { postHogCodeProvider } from '../services/cloudProviders/posthog/provider.js';
import { selfHostedProvider } from '../services/cloudProviders/selfhosted/provider.js';
import { resetFleetAccessCache } from '../services/cloudProviders/fleetAccess.js';

// resolveCloudEnvId resolves through the registry's hasCredentials check.
registerCloudProvider(postHogCodeProvider);
registerCloudProvider(selfHostedProvider);

describe('prCloudFix helpers', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('ACTIVE_STATUSES', () => {
    it.each(['pending', 'queued', 'in_progress'])('treats %s as active', (status) => {
      expect(ACTIVE_STATUSES.has(status)).toBe(true);
    });

    it.each(['completed', 'failed', 'cancelled'])('treats %s as terminal', (status) => {
      expect(ACTIVE_STATUSES.has(status)).toBe(false);
    });
  });

  describe('resolvePostHogEnvId', () => {
    it("returns the workspace owner's posthog_code env marker", async () => {
      await db.insert(environmentsTable).values({
        id: 'env-ph',
        ownerId: TEST_USER_ID,
        name: 'PostHog Code',
        type: 'posthog_code',
        config: {},
      });

      expect(await resolvePostHogEnvId('ws1')).toBe('env-ph');
    });

    it('returns null when the owner has no posthog_code env', async () => {
      expect(await resolvePostHogEnvId('ws1')).toBeNull();
    });

    it('ignores env markers of other provider types', async () => {
      await db.insert(environmentsTable).values({
        id: 'env-codex',
        ownerId: TEST_USER_ID,
        name: 'Codex Cloud',
        type: 'codex_cloud',
        config: {},
      });

      expect(await resolvePostHogEnvId('ws1')).toBeNull();
    });

    it("ignores another user's posthog_code env", async () => {
      await seedUser(db, { id: 'user-other' });
      await db.insert(environmentsTable).values({
        id: 'env-other',
        ownerId: 'user-other',
        name: 'PostHog Code',
        type: 'posthog_code',
        config: {},
      });

      expect(await resolvePostHogEnvId('ws1')).toBeNull();
    });

    it('returns null for an unknown workspace', async () => {
      expect(await resolvePostHogEnvId('ws-missing')).toBeNull();
    });
  });

  describe('resolveCloudEnvId', () => {
    let priorKey: string | undefined;
    let priorAllow: string | undefined;
    beforeAll(() => {
      // Seeding an encrypted credential needs the token-encryption key.
      priorKey = process.env.TALYN_TOKEN_KEY;
      process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
      // The fleet gate fails closed and is keyed on the workspace OWNER's
      // email, so without this every selfhosted link is dropped from the chain
      // and these cases would pass for the wrong reason.
      priorAllow = process.env.FLEET_ALLOWED_EMAILS;
      process.env.FLEET_ALLOWED_EMAILS = `${TEST_USER_ID}@example.test`;
      resetFleetAccessCache();
    });
    afterAll(() => {
      if (priorKey === undefined) delete process.env.TALYN_TOKEN_KEY;
      else process.env.TALYN_TOKEN_KEY = priorKey;
      if (priorAllow === undefined) delete process.env.FLEET_ALLOWED_EMAILS;
      else process.env.FLEET_ALLOWED_EMAILS = priorAllow;
      resetFleetAccessCache();
    });

    async function connectPostHog() {
      await db.insert(environmentsTable).values({
        id: 'env-ph', ownerId: TEST_USER_ID, name: 'PostHog Code', type: 'posthog_code', config: {},
      });
      await db.insert(integrationsTable).values({
        id: 'int-ph', workspaceId: 'ws1', type: 'posthog', enabled: true,
        config: { apiKeyEnc: encryptString('k'), projectId: '1' },
      });
    }
    async function connectFleet() {
      await db.insert(environmentsTable).values({
        id: 'env-fl', ownerId: TEST_USER_ID, name: 'Talyn Fleet', type: 'selfhosted', config: {},
      });
      await db.insert(integrationsTable).values({
        id: 'int-fl', workspaceId: 'ws1', type: 'selfhosted', enabled: true,
        config: { anthropicKeyEnc: encryptString('sk-ant-oat01-test') },
      });
    }
    const setDefault = (v: string) =>
      db.update(workspacesTable).set({ settings: { defaultCloudProvider: v } }).where(eq(workspacesTable.id, 'ws1'));

    // The fleet leads the standard order: it is the better place for the work —
    // a real microVM on the workspace's own agent subscription rather than
    // metered credits. PostHog Code stays as what a non-allow-listed workspace
    // runs on, and as what a full fleet falls back to.
    it('prefers Talyn Fleet when both are connected and no default is set', async () => {
      await connectPostHog();
      await connectFleet();
      expect(await resolveCloudEnvId('ws1')).toBe('env-fl');
    });

    it('honours a pinned default of selfhosted', async () => {
      await connectPostHog();
      await connectFleet();
      await setDefault('selfhosted');
      expect(await resolveCloudEnvId('ws1')).toBe('env-fl');
    });

    it("'ask' falls back to the deterministic order for backend tasks", async () => {
      // A backend-initiated run (auto-keep watcher, merge queue) has nobody to
      // ask, so 'ask' has to resolve to the standard order rather than fail.
      await connectPostHog();
      await connectFleet();
      await setDefault('ask');
      expect(await resolveCloudEnvId('ws1')).toBe('env-fl');
    });

    it('falls back past a pinned provider that isn’t connected', async () => {
      await connectPostHog(); // only PostHog connected
      await setDefault('selfhosted');
      expect(await resolveCloudEnvId('ws1')).toBe('env-ph');
    });

    // The fall-through the fleet gate depends on: a workspace that pinned the
    // fleet and is not on the allow-list should get its task run SOMEWHERE, not
    // fail. Asserted here rather than trusted, because the gate is what decides
    // whether making the fleet the default is safe for everyone else.
    it('drops the fleet for a workspace that is not allow-listed, and runs on PostHog', async () => {
      await connectPostHog();
      await connectFleet();
      await setDefault('selfhosted');
      process.env.FLEET_ALLOWED_EMAILS = 'someone-else@example.test';
      resetFleetAccessCache();
      try {
        expect(await resolveCloudEnvId('ws1')).toBe('env-ph');
      } finally {
        process.env.FLEET_ALLOWED_EMAILS = `${TEST_USER_ID}@example.test`;
        resetFleetAccessCache();
      }
    });

    it('skips a provider whose env exists but has no credentials', async () => {
      // env marker present (lingers after disconnect) but no integration row
      await db.insert(environmentsTable).values({
        id: 'env-ph', ownerId: TEST_USER_ID, name: 'PostHog Code', type: 'posthog_code', config: {},
      });
      expect(await resolveCloudEnvId('ws1')).toBeNull();
    });

    it('returns null when no provider is connected', async () => {
      expect(await resolveCloudEnvId('ws1')).toBeNull();
    });
  });

  describe('linkedTaskStatus', () => {
    it('returns null when the PR has no linked task', async () => {
      expect(await linkedTaskStatus(null)).toBeNull();
    });

    it('returns null when the linked task row no longer exists', async () => {
      expect(await linkedTaskStatus('task-gone')).toBeNull();
    });

    it.each(['queued', 'in_progress', 'completed', 'failed'])(
      'returns the current status (%s) of the linked task',
      async (status) => {
        const now = new Date();
        await db.insert(tasksTable).values({
          id: `task-${status}`,
          workspaceId: 'ws1',
          type: 'pr_response',
          status,
          title: 't',
          description: '',
          priority: 'medium',
          createdAt: now,
          updatedAt: now,
        });

        expect(await linkedTaskStatus(`task-${status}`)).toBe(status);
      }
    );
  });

  describe('startPrMergeableRun', () => {
    let priorKey: string | undefined;
    beforeAll(() => {
      priorKey = process.env.TALYN_TOKEN_KEY;
      process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    });
    afterAll(() => {
      if (priorKey === undefined) delete process.env.TALYN_TOKEN_KEY;
      else process.env.TALYN_TOKEN_KEY = priorKey;
    });

    const prRow = {
      id: 'pr-1',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'a',
      repo: 'b',
      number: 1,
      lastSummary: {
        title: 'PR title',
        url: 'https://github.com/a/b/pull/1',
        headBranch: 'feat',
        baseBranch: 'main',
        mergeable: 'CONFLICTING',
        blockingReason: 'merge_conflicts',
        checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
        unresolvedReviewThreads: 0,
      },
    };

    beforeEach(async () => {
      await db.insert(environmentsTable).values({
        id: 'env-ph', ownerId: TEST_USER_ID, name: 'PostHog Code', type: 'posthog_code', config: {},
      });
      await db.insert(integrationsTable).values({
        id: 'int-ph', workspaceId: 'ws1', type: 'posthog', enabled: true,
        config: { apiKeyEnc: encryptString('k'), projectId: '1' },
      });
      await db.insert(repositoriesTable).values({
        id: 'repo1', workspaceId: 'ws1', name: 'a/b', url: 'https://github.com/a/b', defaultBranch: 'main',
      });
      // The row `prRow` describes. Required since tasks.pull_request_id became
      // a real foreign key: a task claiming to work a PR with no row is
      // meaningless, and the in-flight guard could never find it anyway.
      await db.insert(pullRequestsTable).values({
        id: 'pr-1',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'a',
        repo: 'b',
        number: 1,
        state: 'open',
        lastPolledAt: new Date(),
        lastSummary: prRow.lastSummary,
      });
    });

    it('renders the default mergeable prompt when the workspace has no override', async () => {
      const result = await startPrMergeableRun(prRow);
      expect(result.ok).toBe(true);
      const tasks = await db.select({ prompt: tasksTable.prompt }).from(tasksTable);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toContain('Every reviewer comment is resolved');
      expect(tasks[0].prompt).toContain('https://github.com/a/b/pull/1');
    });

    it('renders the workspace mergeable prompt override when one is set', async () => {
      await db
        .update(workspacesTable)
        .set({
          settings: {
            prompts: {
              mergeable: {
                template: 'Custom for {{pr.ref}} on {{pr.headBranch}}\n{{gitRules}}',
                basedOnHash: '00000000',
                updatedAt: 'then',
              },
            },
          },
        })
        .where(eq(workspacesTable.id, 'ws1'));

      const result = await startPrMergeableRun(prRow);
      expect(result.ok).toBe(true);
      const tasks = await db.select({ prompt: tasksTable.prompt }).from(tasksTable);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt?.startsWith('Custom for a/b#1 on feat')).toBe(true);
      expect(tasks[0].prompt).toContain('git_signed_commit');
      expect(tasks[0].prompt).not.toContain('Every reviewer comment');
    });

    it('reports no_cloud_provider when the workspace has none connected', async () => {
      await db.delete(integrationsTable).where(eq(integrationsTable.id, 'int-ph'));
      const result = await startPrMergeableRun(prRow);
      expect(result).toEqual({ ok: false, reason: 'no_cloud_provider' });
      expect(await db.select({ id: tasksTable.id }).from(tasksTable)).toHaveLength(0);
    });
  });
});
