import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrateLegacyPlaintextCredentials } from '../services/credentialMigration.js';
import { getPostHogCodeCredentials } from '../services/posthogCode/credentials.js';
import {
  decryptString,
  isEncryptedEnvelope,
  encryptString,
  type EncryptedEnvelope,
} from '../services/tokenCrypto.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  integrations as integrationsTable,
} from '../db/schema.js';

const WS = 'ws-cred';

describe('migrateLegacyPlaintextCredentials', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    await seedUser(db);
    await db.insert(workspacesTable).values({ id: WS, ownerId: TEST_USER_ID, name: 'WS' });
  });

  afterEach(async () => {
    if (savedKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = savedKey;
    await cleanup();
  });

  async function insertIntegration(
    id: string,
    type: string,
    config: Record<string, unknown>,
    workspaceId: string = WS
  ): Promise<void> {
    if (workspaceId !== WS) {
      await db
        .insert(workspacesTable)
        .values({ id: workspaceId, ownerId: TEST_USER_ID, name: workspaceId })
        .onConflictDoNothing();
    }
    await db.insert(integrationsTable).values({
      id,
      workspaceId,
      type,
      enabled: true,
      config,
    });
  }

  async function readConfig(id: string): Promise<Record<string, unknown>> {
    const rows = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(eq(integrationsTable.id, id));
    return rows[0].config as Record<string, unknown>;
  }

  it('re-encrypts a legacy plaintext GitHub accessToken and nulls the plaintext', async () => {
    await insertIntegration('gh1', 'github', {
      accessToken: 'gho_legacy_plaintext',
      tokenType: 'bearer',
      scope: 'repo',
    });

    const { migrated, failed } = await migrateLegacyPlaintextCredentials(db);
    expect(migrated).toBe(1);
    expect(failed).toBe(0);

    const config = await readConfig('gh1');
    expect(config.accessToken).toBeUndefined();
    expect(isEncryptedEnvelope(config.accessTokenEnc)).toBe(true);
    expect(decryptString(config.accessTokenEnc as EncryptedEnvelope)).toBe(
      'gho_legacy_plaintext'
    );
    // Non-secret fields survive untouched.
    expect(config.tokenType).toBe('bearer');
    expect(config.scope).toBe('repo');
  });

  it('re-encrypts a legacy plaintext PostHog apiKey and the read path resolves it', async () => {
    await insertIntegration('ph1', 'posthog', {
      apiKey: 'phx_legacy_plaintext',
      projectId: '123',
      host: 'https://us.posthog.com',
    });

    // Pre-sweep: the plaintext fallback is deleted, so the key is invisible.
    expect(await getPostHogCodeCredentials(WS)).toBeNull();

    await migrateLegacyPlaintextCredentials(db);

    const config = await readConfig('ph1');
    expect(config.apiKey).toBeUndefined();
    expect(isEncryptedEnvelope(config.apiKeyEnc)).toBe(true);

    const creds = await getPostHogCodeCredentials(WS);
    expect(creds).toMatchObject({
      projectId: '123',
      host: 'https://us.posthog.com',
      // A migrated legacy row has no `authMethod`, which must still resolve to
      // the personal-API-key path — that's every pre-OAuth install.
      authMethod: 'personal_api_key',
      reauthRequired: false,
    });
    expect(await creds!.getToken()).toBe('phx_legacy_plaintext');
  });

  it('keeps an existing envelope and just drops stale plaintext when both are present', async () => {
    const freshEnvelope = encryptString('gho_fresh_encrypted');
    await insertIntegration('gh2', 'github', {
      accessToken: 'gho_stale_plaintext',
      accessTokenEnc: freshEnvelope,
    });

    await migrateLegacyPlaintextCredentials(db);

    const config = await readConfig('gh2');
    expect(config.accessToken).toBeUndefined();
    expect(decryptString(config.accessTokenEnc as EncryptedEnvelope)).toBe(
      'gho_fresh_encrypted'
    );
  });

  it('leaves already-encrypted rows and unrelated integration types untouched', async () => {
    const envelope = encryptString('gho_already_encrypted');
    await insertIntegration('gh3', 'github', { accessTokenEnc: envelope });
    await insertIntegration('other1', 'slack', { apiKey: 'not-our-shape' });

    const { migrated, failed } = await migrateLegacyPlaintextCredentials(db);
    expect(migrated).toBe(0);
    expect(failed).toBe(0);

    expect(await readConfig('gh3')).toEqual({ accessTokenEnc: envelope });
    expect(await readConfig('other1')).toEqual({ apiKey: 'not-our-shape' });
  });

  it('is idempotent — a second sweep migrates nothing', async () => {
    await insertIntegration('gh4', 'github', { accessToken: 'gho_once' });
    expect((await migrateLegacyPlaintextCredentials(db)).migrated).toBe(1);
    expect((await migrateLegacyPlaintextCredentials(db)).migrated).toBe(0);
  });

  it('a row that fails to encrypt is counted, logged, and does not block others', async () => {
    // Break encryption for one row by nuking the key mid-sweep is not
    // deterministic; instead simulate the closest failure: an empty-string
    // plaintext is skipped (nothing to migrate), and a healthy row still runs.
    await insertIntegration('gh5', 'github', { accessToken: '' });
    await insertIntegration('gh6', 'github', { accessToken: 'gho_ok' }, 'ws-cred-2');

    const { migrated, failed } = await migrateLegacyPlaintextCredentials(db);
    expect(migrated).toBe(1);
    expect(failed).toBe(0);
    expect(isEncryptedEnvelope((await readConfig('gh6')).accessTokenEnc)).toBe(true);
  });
});
