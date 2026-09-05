import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readCloudTaskMeta } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { tasks as tasksTable, workspaces as workspacesTable } from '../db/schema.js';
import {
  ADMIN_TASK_LIST_COLUMNS,
  cloudFieldsFromMetadata,
} from '../services/admin/queries.js';
import type { Database } from '../db/client.js';

/**
 * Pins the task list's SQL jsonb extraction to the JS semantics it replaces.
 *
 * CLAUDE.md requires this whenever a scalar is computed in SQL instead of
 * fetching a blob — the precedents are `cloudPollerEgress.test.ts` and
 * `prMonitorFastPollEgress.test.ts`. Without it the two drift silently: the
 * SQL keeps returning *a* value, just not the one the rest of the codebase
 * would have computed, and the console shows a task as having no provider
 * while every other surface shows it running.
 *
 * The legacy arm is the part that actually breaks. `readCloudTaskMeta` falls
 * back to flat `posthogTaskId` / `posthogRunId` / `posthogStatus` keys for
 * tasks written before the `cloudTask` envelope existed, and a naive
 * `metadata -> 'cloudTask' ->> 'provider'` returns null for every one of them.
 */

let db: Database;
let cleanup: () => Promise<void>;

/** Both metadata shapes, plus the ways each can be partial. */
const FIXTURES: Array<{ id: string; label: string; metadata: Record<string, unknown> | null }> = [
  {
    id: 'task-modern-full',
    label: 'a modern cloudTask envelope with fleet extras',
    metadata: {
      cloudTask: {
        provider: 'selfhosted',
        remoteTaskId: 'talyn-1',
        remoteRunId: 'talyn-1',
        status: 'running',
        prUrl: 'https://github.com/o/r/pull/1',
        extra: { host: 'hetzner-64', phase: 'agent', costUsd: 0.42, repo: 'o/r' },
      },
    },
  },
  {
    id: 'task-modern-no-extra',
    label: 'a modern envelope with no extras (a non-fleet provider)',
    metadata: {
      cloudTask: {
        provider: 'selfhosted',
        remoteTaskId: 'ct-9',
        status: 'completed',
      },
    },
  },
  {
    id: 'task-legacy',
    label: 'a legacy flat posthog* task',
    metadata: {
      posthogTaskId: 'ph-123',
      posthogRunId: 'ph-run-123',
      posthogStatus: 'in_progress',
      posthogPrUrl: 'https://github.com/o/r/pull/2',
    },
  },
  {
    id: 'task-legacy-partial',
    label: 'a legacy task that never started a run',
    metadata: { posthogTaskId: 'ph-456' },
  },
  {
    id: 'task-no-cloud',
    label: 'a task with no cloud association at all',
    metadata: {},
  },
  {
    id: 'task-null-meta',
    label: 'a task with null metadata',
    metadata: null,
  },
  {
    id: 'task-cost-string',
    label: 'costUsd serialised as a string',
    metadata: {
      cloudTask: {
        provider: 'selfhosted',
        remoteTaskId: 'talyn-2',
        extra: { host: 'hetzner-64', costUsd: '1.5' },
      },
    },
  },
];

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: TEST_USER_ID });
  await db
    .insert(workspacesTable)
    .values({ id: 'ws-1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
  await db.insert(tasksTable).values(
    FIXTURES.map((f) => ({
      id: f.id,
      workspaceId: 'ws-1',
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: f.label,
      description: '',
      metadata: f.metadata,
    }))
  );
});

afterEach(async () => {
  await cleanup();
});

describe('ADMIN_TASK_LIST_COLUMNS jsonb extraction', () => {
  it('agrees with the JS helper on every metadata shape', async () => {
    const rows = await db.select(ADMIN_TASK_LIST_COLUMNS).from(tasksTable);
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const fixture of FIXTURES) {
      const sqlRow = byId.get(fixture.id);
      expect(sqlRow, `${fixture.label} was not selected`).toBeDefined();
      const expected = cloudFieldsFromMetadata(fixture.metadata);

      expect(sqlRow!.provider ?? null, `provider for ${fixture.label}`).toBe(expected.provider);
      expect(sqlRow!.remoteRunId ?? null, `remoteRunId for ${fixture.label}`).toBe(
        expected.remoteRunId
      );
      expect(sqlRow!.cloudStatus ?? null, `cloudStatus for ${fixture.label}`).toBe(
        expected.cloudStatus
      );
      expect(sqlRow!.fleetHost ?? null, `fleetHost for ${fixture.label}`).toBe(expected.fleetHost);
      expect(sqlRow!.phase ?? null, `phase for ${fixture.label}`).toBe(expected.phase);
      const cost = sqlRow!.costUsd == null ? null : Number(sqlRow!.costUsd);
      expect(cost, `costUsd for ${fixture.label}`).toBe(expected.costUsd);
    }
  });

  it('resolves a legacy task to posthog_code, not null', async () => {
    // The specific regression: without the COALESCE arm every pre-envelope
    // task renders in the console as having no cloud run.
    const rows = await db.select(ADMIN_TASK_LIST_COLUMNS).from(tasksTable);
    const legacy = rows.find((r) => r.id === 'task-legacy');
    expect(legacy?.provider).toBe('posthog_code');
    expect(legacy?.remoteRunId).toBe('ph-run-123');
    expect(legacy?.cloudStatus).toBe('in_progress');
  });

  it('leaves a genuinely cloud-less task null rather than inventing a provider', async () => {
    const rows = await db.select(ADMIN_TASK_LIST_COLUMNS).from(tasksTable);
    for (const id of ['task-no-cloud', 'task-null-meta']) {
      const row = rows.find((r) => r.id === id);
      expect(row?.provider ?? null).toBeNull();
      expect(row?.remoteRunId ?? null).toBeNull();
    }
  });
});

describe('cloudFieldsFromMetadata vs readCloudTaskMeta', () => {
  it.each(FIXTURES.map((f) => [f.label, f.metadata] as const))(
    'derives the same provider/run/status as the canonical helper for %s',
    (_label, metadata) => {
      // cloudFieldsFromMetadata is a PROJECTION of readCloudTaskMeta onto the
      // columns the list renders. If it ever disagrees, the canonical helper
      // is right and this one is wrong — that direction is the whole point of
      // keeping readCloudTaskMeta in @talyn/shared.
      const canonical = readCloudTaskMeta({ metadata });
      const projected = cloudFieldsFromMetadata(metadata);
      expect(projected.provider).toBe(canonical?.provider ?? null);
      expect(projected.remoteRunId).toBe(canonical?.remoteRunId ?? null);
      expect(projected.cloudStatus).toBe(canonical?.status ?? null);
    }
  );
});
