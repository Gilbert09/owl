import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { externalQueueSubmitRoutes } from '../db/schema.js';
import {
  noteExternalQueueSubmitRoute,
  rememberedExternalQueueSubmitRoute,
  loadExternalQueueSubmitRoutes,
  _resetSubmitRoutes,
} from '../services/externalQueueSubmitRoute.js';

/**
 * The property this table exists for: the submit command has to outlive the
 * process. It first shipped as a bare Map, so every deploy dropped it — and on
 * PostHog/posthog that did not mean "a slower door", it meant falling through
 * to the submit LABEL, which trunk refuses for Talyn's App and deletes again
 * (#82679: 61 label events in an hour).
 */
describe('externalQueueSubmitRoute', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    _resetSubmitRoutes();
  });
  afterEach(async () => {
    _resetSubmitRoutes();
    await cleanup();
  });

  const trunkMerge = { provider: 'trunk' as const, command: '/trunk merge' };

  /** Everything a restart keeps is what the table holds — so wipe memory and reload. */
  async function restart(): Promise<void> {
    _resetSubmitRoutes();
    await loadExternalQueueSubmitRoutes();
  }

  it('survives a restart', async () => {
    noteExternalQueueSubmitRoute('PostHog', 'posthog', trunkMerge);
    await new Promise((r) => setTimeout(r, 50)); // the persist is fire-and-forget
    await restart();
    expect(rememberedExternalQueueSubmitRoute('PostHog', 'posthog')).toEqual(trunkMerge);
  });

  it('is repo-scoped and case-insensitive on the repo name', async () => {
    noteExternalQueueSubmitRoute('PostHog', 'PostHog', trunkMerge);
    await new Promise((r) => setTimeout(r, 50));
    await restart();
    expect(rememberedExternalQueueSubmitRoute('posthog', 'posthog')).toEqual(trunkMerge);
    expect(rememberedExternalQueueSubmitRoute('acme', 'widgets')).toBeNull();
  });

  it('writes once for a repeated command — comment traffic must not become write traffic', async () => {
    noteExternalQueueSubmitRoute('acme', 'widgets', trunkMerge);
    await new Promise((r) => setTimeout(r, 50));
    const before = await db.select().from(externalQueueSubmitRoutes);
    const firstWrite = before[0].updatedAt;
    for (let i = 0; i < 5; i++) noteExternalQueueSubmitRoute('acme', 'widgets', trunkMerge);
    await new Promise((r) => setTimeout(r, 50));
    const after = await db.select().from(externalQueueSubmitRoutes);
    expect(after).toHaveLength(1);
    expect(after[0].updatedAt).toEqual(firstWrite);
  });

  it('takes a changed command and keeps one row per repo', async () => {
    noteExternalQueueSubmitRoute('acme', 'widgets', trunkMerge);
    await new Promise((r) => setTimeout(r, 50));
    noteExternalQueueSubmitRoute('acme', 'widgets', { provider: 'trunk', command: '/trunk merge --now' });
    await new Promise((r) => setTimeout(r, 50));
    await restart();
    expect(rememberedExternalQueueSubmitRoute('acme', 'widgets')?.command).toBe('/trunk merge --now');
    expect(await db.select().from(externalQueueSubmitRoutes)).toHaveLength(1);
  });

  it('is null for a repo nothing has taught it', async () => {
    await restart();
    expect(rememberedExternalQueueSubmitRoute('acme', 'widgets')).toBeNull();
  });
});
