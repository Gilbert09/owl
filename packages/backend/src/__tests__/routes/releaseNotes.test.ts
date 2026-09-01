import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import type { ReleaseHighlight, ReleaseNoteEntry } from '@talyn/shared';
import {
  releaseNotesPublicRoutes,
  releaseNotesRoutes,
  RELEASE_SECRET_HEADER,
} from '../../routes/releaseNotes.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';

const SECRET = 'test-release-ingest-secret';

const highlight = (over: Partial<ReleaseHighlight> = {}): ReleaseHighlight => ({
  title: 'Watch a PR you did not write',
  description: 'Paste a pull request URL to track its checks alongside your own.',
  kind: 'feature',
  surfaces: ['desktop', 'web'],
  ...over,
});

/**
 * Mirrors the real mount in routes/index.ts: the ingest sits in the public
 * block (no requireAuth, shared-secret gate inside), the reads sit after
 * requireAuth but before ownerScope.
 */
async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/release-notes', releaseNotesPublicRoutes());
  app.use('/api/v1/release-notes', requireAuth, releaseNotesRoutes());
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

describe('routes/release-notes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let server: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    server = await makeServer();
    process.env.TALYN_RELEASE_INGEST_SECRET = SECRET;
  });

  afterEach(async () => {
    delete process.env.TALYN_RELEASE_INGEST_SECRET;
    await server.close();
    await cleanup();
  });

  const ingest = (body: unknown, secret: string | null = SECRET) =>
    fetch(`${server.url}/api/v1/release-notes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret === null ? {} : { [RELEASE_SECRET_HEADER]: secret }),
      },
      body: JSON.stringify(body),
    });

  const publish = (version: string, highlights: ReleaseHighlight[] = [highlight()]) =>
    ingest({ version, publishedAt: '2026-08-30T03:00:00.000Z', highlights });

  const read = async (path: string) => {
    const res = await fetch(`${server.url}/api/v1/release-notes${path}`, {
      headers: internalProxyHeaders(TEST_USER_ID),
    });
    const body = (await res.json()) as { success: boolean; data: unknown };
    return { status: res.status, body };
  };

  // --- ingest ------------------------------------------------------------

  it('records a release and serves it back', async () => {
    expect((await publish('0.2.61')).status).toBe(201);

    const { status, body } = await read('');
    expect(status).toBe(200);
    expect(body.data).toEqual([
      {
        version: '0.2.61',
        publishedAt: '2026-08-30T03:00:00.000Z',
        highlights: [highlight()],
      },
    ] satisfies ReleaseNoteEntry[]);
  });

  it('strips a leading v from the tag, so v0.2.61 and 0.2.61 are one release', async () => {
    await publish('v0.2.61');
    await publish('0.2.61', [highlight({ title: 'Second write' })]);
    const { body } = await read('');
    expect(body.data).toHaveLength(1);
    expect((body.data as ReleaseNoteEntry[])[0].version).toBe('0.2.61');
  });

  it('is idempotent — a re-run of the publish workflow is not an error', async () => {
    expect((await publish('0.2.61')).status).toBe(201);
    expect((await publish('0.2.61')).status).toBe(201);
    const { body } = await read('');
    expect(body.data).toHaveLength(1);
  });

  it('rejects a wrong, absent, or empty secret', async () => {
    expect((await ingest({ version: '0.2.61' }, 'wrong')).status).toBe(401);
    expect((await ingest({ version: '0.2.61' }, null)).status).toBe(401);
    expect((await ingest({ version: '0.2.61' }, '')).status).toBe(401);
    const { body } = await read('');
    expect(body.data).toEqual([]);
  });

  it('404s — not 401 — when the secret is not configured at all', async () => {
    // An unconfigured deployment should not advertise that this endpoint
    // exists, let alone that it is guarded by a secret worth guessing.
    delete process.env.TALYN_RELEASE_INGEST_SECRET;
    expect((await publish('0.2.61')).status).toBe(404);
  });

  it('rejects a malformed version, date, or highlight list', async () => {
    const cases: [string, unknown][] = [
      ['bad version', { version: '0.2', publishedAt: '2026-08-30T03:00:00Z', highlights: [] }],
      ['no version', { publishedAt: '2026-08-30T03:00:00Z', highlights: [] }],
      ['bad date', { version: '0.2.61', publishedAt: 'last tuesday', highlights: [] }],
      ['no date', { version: '0.2.61', highlights: [] }],
      ['highlights not an array', { version: '0.2.61', publishedAt: '2026-08-30T03:00:00Z', highlights: {} }],
      [
        'bad kind',
        {
          version: '0.2.61',
          publishedAt: '2026-08-30T03:00:00Z',
          highlights: [{ ...highlight(), kind: 'refactor' }],
        },
      ],
      [
        'empty surfaces',
        {
          version: '0.2.61',
          publishedAt: '2026-08-30T03:00:00Z',
          highlights: [{ ...highlight(), surfaces: [] }],
        },
      ],
    ];
    for (const [label, payload] of cases) {
      const res = await ingest(payload);
      expect(res.status, label).toBe(400);
    }
    const { body } = await read('');
    expect(body.data).toEqual([]);
  });

  it('accepts a release with no highlights', async () => {
    // Most nightlies. The row is what keeps `?since=` correct.
    expect((await publish('0.2.61', [])).status).toBe(201);
    const { body } = await read('');
    expect((body.data as ReleaseNoteEntry[])[0].highlights).toEqual([]);
  });

  // --- reads -------------------------------------------------------------

  it('requires a session to read', async () => {
    await publish('0.2.61');
    const res = await fetch(`${server.url}/api/v1/release-notes`);
    expect(res.status).toBe(401);
  });

  it('serves newest first and honours ?since=', async () => {
    await publish('0.2.9');
    await publish('0.2.10');
    await publish('0.2.11');

    const all = await read('');
    expect((all.body.data as ReleaseNoteEntry[]).map((e) => e.version)).toEqual([
      '0.2.11',
      '0.2.10',
      '0.2.9',
    ]);

    const since = await read('?since=0.2.9');
    expect((since.body.data as ReleaseNoteEntry[]).map((e) => e.version)).toEqual([
      '0.2.11',
      '0.2.10',
    ]);

    const caughtUp = await read('?since=0.2.11');
    expect(caughtUp.body.data).toEqual([]);
  });

  it('serves the newest release on /latest, and null when there is none', async () => {
    const empty = await read('/latest');
    expect(empty.status).toBe(200);
    expect(empty.body.data).toBeNull();

    await publish('0.2.9');
    await publish('0.2.10');
    const latest = await read('/latest');
    expect((latest.body.data as ReleaseNoteEntry).version).toBe('0.2.10');
  });
});
