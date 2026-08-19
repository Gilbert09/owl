import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { PROMPT_TEMPLATE_MAX_CHARS, defaultPromptTemplateHash } from '@talyn/shared';
import { workspaceRoutes } from '../../routes/workspaces.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  integrations as integrationsTable,
} from '../../db/schema.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '2mb' })); // mirror production (logo uploads)
  app.use('/workspaces', requireAuth, workspaceRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/workspaces', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
  });

  it('rejects unauthenticated callers', async () => {
    const res = await fetch(`${serverUrl}/workspaces`);
    expect(res.status).toBe(401);
  });

  describe('POST /workspaces', () => {
    it('creates a workspace owned by the caller with default settings', async () => {
      const res = await fetch(`${serverUrl}/workspaces`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'My Workspace', description: 'desc' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.name).toBe('My Workspace');
      expect(body.data.description).toBe('desc');
      expect(body.data.settings).toEqual({});
      expect(body.data.repos).toEqual([]);
      expect(body.data.integrations).toEqual({});
    });

    it('auto-generates an identicon logo when none is provided', async () => {
      const res = await fetch(`${serverUrl}/workspaces`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Logo WS' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.logo.kind).toBe('identicon');
      expect(typeof body.data.logo.seed).toBe('string');
      expect(body.data.logo.seed.length).toBeGreaterThan(0);
    });

    it('rejects an oversized uploaded logo image', async () => {
      const huge = 'data:image/png;base64,' + 'A'.repeat(600 * 1024);
      const res = await fetch(`${serverUrl}/workspaces`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Big', logo: { kind: 'image', dataUrl: huge } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/too large/i);
    });
  });

  describe('GET /workspaces', () => {
    it('returns only the caller own workspaces with repos + integrations hydrated', async () => {
      await db.insert(workspacesTable).values([
        { id: 'a', ownerId: TEST_USER_ID, name: 'Alpha', settings: {} },
        { id: 'b', ownerId: TEST_USER_ID, name: 'Beta', settings: {} },
        { id: 'c', ownerId: OTHER_USER_ID, name: 'Other', settings: {} },
      ]);
      await db.insert(repositoriesTable).values([
        {
          id: 'r1',
          workspaceId: 'a',
          name: 'acme/widgets',
          url: 'https://github.com/acme/widgets',
          defaultBranch: 'main',
        },
      ]);
      await db.insert(integrationsTable).values([
        { id: 'i1', workspaceId: 'a', type: 'github', enabled: true, config: {} },
      ]);

      const res = await fetch(`${serverUrl}/workspaces`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      const names = (body.data as Array<{ name: string }>).map((w) => w.name).sort();
      expect(names).toEqual(['Alpha', 'Beta']);
      const alpha = (body.data as Array<{ id: string; repos: unknown[]; integrations: Record<string, unknown> }>).find((w) => w.id === 'a')!;
      expect(alpha.repos).toHaveLength(1);
      // Only the enabled flag should leak; no config blob.
      expect(alpha.integrations.github).toEqual({ enabled: true, watchedRepos: [] });
    });

    it('returns an empty array for a user with no workspaces', async () => {
      const res = await fetch(`${serverUrl}/workspaces`, { headers: authHeaders });
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });

  describe('GET /workspaces/:id', () => {
    it('returns an owned workspace', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('a');
    });

    it('404s a workspace owned by someone else', async () => {
      await db.insert(workspacesTable).values({
        id: 'x',
        ownerId: OTHER_USER_ID,
        name: 'Other',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/x`, { headers: authHeaders });
      expect(res.status).toBe(404);
    });

    it('404s a missing workspace id', async () => {
      const res = await fetch(`${serverUrl}/workspaces/nope`, { headers: authHeaders });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /workspaces/:id', () => {
    it('updates the logo to a new identicon seed', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        logo: { kind: 'identicon', seed: 'old-seed' },
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ logo: { kind: 'identicon', seed: 'new-seed' } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.logo).toEqual({ kind: 'identicon', seed: 'new-seed' });
    });

    it('rejects a logo with an unknown kind', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ logo: { kind: 'svg', data: 'x' } }),
      });
      expect(res.status).toBe(400);
    });

    it('merges settings with existing values rather than replacing', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        settings: { keep: 'a', replace: 'old' },
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ settings: { replace: 'new' } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Partial settings PATCH merges into the existing blob.
      expect(body.data.settings).toEqual({
        keep: 'a', // preserved
        replace: 'new', // overridden
      });
    });

    it('updates name + description independently', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        description: 'old',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Renamed' }),
      });
      const body = await res.json();
      expect(body.data.name).toBe('Renamed');
      expect(body.data.description).toBe('old');
    });

    // autoApprove switches on an irreversible outward-facing action (the queue
    // finalizes visual-review runs, rewriting the committed baseline), so it is
    // validated strictly rather than coerced.
    describe('settings.visualReview', () => {
      async function patchVr(visualReview: unknown) {
        return fetch(`${serverUrl}/workspaces/a`, {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ settings: { visualReview } }),
        });
      }

      beforeEach(async () => {
        await db.insert(workspacesTable).values({
          id: 'a',
          ownerId: TEST_USER_ID,
          name: 'Alpha',
          settings: {},
        });
      });

      it('stores a valid opt-in', async () => {
        const res = await patchVr({ autoApprove: true, projectId: '2' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { settings: Record<string, unknown> } };
        expect(body.data.settings.visualReview).toEqual({ autoApprove: true, projectId: '2' });
      });

      // "false" is truthy in JS — coercing it would silently arm the thing.
      it.each([['"false"', 'false'], ['1', 1], ['null', null]])(
        'rejects autoApprove: %s rather than coercing it',
        async (_label, autoApprove) => {
          expect((await patchVr({ autoApprove })).status).toBe(400);
        }
      );

      it('rejects a non-numeric project id', async () => {
        expect((await patchVr({ projectId: 'two' })).status).toBe(400);
      });

      it('rejects an unknown key rather than storing it silently', async () => {
        expect((await patchVr({ autoApprove: true, approveAll: true })).status).toBe(400);
      });

      it('rejects a non-object', async () => {
        expect((await patchVr(true)).status).toBe(400);
      });
    });

    describe('settings.prompts', () => {
      const validTemplate = 'Fix {{pr.url}}\n{{gitRules}}';
      const hash = defaultPromptTemplateHash('mergeable');

      async function patchPrompts(prompts: unknown) {
        return fetch(`${serverUrl}/workspaces/a`, {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ settings: { prompts } }),
        });
      }

      beforeEach(async () => {
        await db.insert(workspacesTable).values({
          id: 'a',
          ownerId: TEST_USER_ID,
          name: 'Alpha',
          settings: {
            defaultCloudProvider: 'claude_code',
            prompts: { skill: { template: 'Run {{pr.url}} {{gitRules}} {{skill.content}}', basedOnHash: 'aaaaaaaa', updatedAt: 'then' } },
          },
        });
      });

      it('stores a valid override with a server-side updatedAt and keeps the other kinds', async () => {
        const res = await patchPrompts({ mergeable: { template: validTemplate, basedOnHash: hash } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.settings.defaultCloudProvider).toBe('claude_code');
        expect(body.data.settings.prompts.mergeable).toMatchObject({ template: validTemplate, basedOnHash: hash });
        expect(typeof body.data.settings.prompts.mergeable.updatedAt).toBe('string');
        expect(body.data.settings.prompts.skill.basedOnHash).toBe('aaaaaaaa');
      });

      it('null resets a kind by dropping the key', async () => {
        const res = await patchPrompts({ skill: null });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.settings.prompts).toEqual({});
      });

      it('keeps every write when PATCHes overlap: two kinds and a top-level key', async () => {
        const responses = await Promise.all([
          patchPrompts({ mergeable: { template: validTemplate, basedOnHash: hash } }),
          patchPrompts({ skill: null }),
          fetch(`${serverUrl}/workspaces/a`, {
            method: 'PATCH',
            headers: authHeaders,
            body: JSON.stringify({ settings: { defaultCloudProvider: 'posthog_code' } }),
          }),
        ]);
        expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
        const rows = await db
          .select({ settings: workspacesTable.settings })
          .from(workspacesTable)
          .where(eq(workspacesTable.id, 'a'));
        const settings = rows[0].settings as {
          defaultCloudProvider: string;
          prompts: { mergeable?: { template: string }; skill?: unknown };
        };
        expect(settings.defaultCloudProvider).toBe('posthog_code');
        expect(settings.prompts.mergeable?.template).toBe(validTemplate);
        expect(settings.prompts.skill).toBeUndefined();
      });

      it.each([
        ['an unknown kind', { bogus: { template: validTemplate, basedOnHash: hash } }, /Unknown prompt kind/],
        ['a non-object kind', { mergeable: 'text' }, /must be an object/],
        ['a missing template', { mergeable: { basedOnHash: hash } }, /template must be a string/],
        ['an unknown variable', { mergeable: { template: `${validTemplate} {{nope}}`, basedOnHash: hash } }, /Unknown variable/],
        ['a missing required variable', { mergeable: { template: 'no rules {{pr.url}}', basedOnHash: hash } }, /Missing required/],
        ['a bad hash', { mergeable: { template: validTemplate, basedOnHash: 'nope' } }, /hex hash/],
        [
          'a template over the size cap',
          { mergeable: { template: validTemplate + 'x'.repeat(PROMPT_TEMPLATE_MAX_CHARS), basedOnHash: hash } },
          /the limit is/,
        ],
        ['a non-object prompts value', 'nope', /must be an object/],
      ])('rejects %s with a 400 and leaves settings untouched', async (_label, prompts, message) => {
        const res = await patchPrompts(prompts);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(message);
        const rows = await db
          .select({ settings: workspacesTable.settings })
          .from(workspacesTable)
          .where(eq(workspacesTable.id, 'a'));
        expect((rows[0].settings as { prompts: { mergeable?: unknown } }).prompts.mergeable).toBeUndefined();
      });
    });

    it('404s a workspace owned by someone else', async () => {
      await db.insert(workspacesTable).values({
        id: 'x',
        ownerId: OTHER_USER_ID,
        name: 'Other',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/x`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ name: 'hijack' }),
      });
      expect(res.status).toBe(404);
      const rows = await db
        .select({ name: workspacesTable.name })
        .from(workspacesTable)
        .where(eq(workspacesTable.id, 'x'));
      expect(rows[0].name).toBe('Other');
    });
  });

  describe('DELETE /workspaces/:id', () => {
    it('removes an owned workspace', async () => {
      await db.insert(workspacesTable).values({
        id: 'a',
        ownerId: TEST_USER_ID,
        name: 'Alpha',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/a`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(workspacesTable);
      expect(rows).toHaveLength(0);
    });

    it('404s on a workspace owned by someone else (no leak)', async () => {
      await db.insert(workspacesTable).values({
        id: 'x',
        ownerId: OTHER_USER_ID,
        name: 'Other',
        settings: {},
      });
      const res = await fetch(`${serverUrl}/workspaces/x`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
      const rows = await db.select().from(workspacesTable);
      expect(rows).toHaveLength(1);
    });
  });
});
