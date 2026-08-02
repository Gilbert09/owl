import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import { createTestDb } from './helpers/testDb.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';
import {
  isFleetAllowedEmail,
  fleetAllowlistIsEmpty,
  fleetRefusalReason,
  resetFleetAccessCache,
  workspaceMayUseFleet,
} from '../services/cloudProviders/fleetAccess.js';

/**
 * The fleet allowlist.
 *
 * Every test here asserts a REFUSAL as well as an acceptance. A gate that only
 * has a passing case is the shape of the billing `clientGate` bug this codebase
 * already paid for: it read as opt-in, so the CLI, the MCP server and plain
 * curl all bypassed the paywall with no error, no log and no metric. The
 * question is never "does it let the right person through" — it is "can it be
 * seen to stop the wrong one".
 */
describe('fleet access allowlist', () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    resetFleetAccessCache();
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    delete process.env.FLEET_ALLOWED_EMAILS;
    resetFleetAccessCache();
  });

  describe('isFleetAllowedEmail', () => {
    it('lets NOBODY through when the allowlist is unset', () => {
      delete process.env.FLEET_ALLOWED_EMAILS;
      resetFleetAccessCache();
      expect(fleetAllowlistIsEmpty()).toBe(true);
      // The one that matters. An empty allowlist meaning "everyone" is the
      // inverse of this gate's whole purpose, and it is the default a careless
      // implementation lands on.
      expect(isFleetAllowedEmail('tom@example.com')).toBe(false);
      expect(isFleetAllowedEmail('anyone@anywhere.com')).toBe(false);
    });

    it('lets nobody through when the allowlist is only whitespace or commas', () => {
      for (const raw of ['  ', ',', ' , , ', '\n']) {
        process.env.FLEET_ALLOWED_EMAILS = raw;
        resetFleetAccessCache();
        expect(fleetAllowlistIsEmpty()).toBe(true);
        expect(isFleetAllowedEmail('tom@example.com')).toBe(false);
      }
    });

    it.each([
      ['exact match', 'tom@example.com', 'tom@example.com', true],
      ['different case in the env', 'Tom@Example.COM', 'tom@example.com', true],
      ['different case in the input', 'tom@example.com', 'TOM@EXAMPLE.com', true],
      ['surrounding whitespace', ' tom@example.com , other@x.com ', 'tom@example.com', true],
      ['second entry in the list', 'a@x.com,tom@example.com', 'tom@example.com', true],
      ['not on the list', 'tom@example.com', 'mallory@example.com', false],
      ['substring of an allowed address', 'tom@example.com', 'om@example.com', false],
      ['superstring of an allowed address', 'tom@example.com', 'tom@example.com.evil.com', false],
      ['empty input', 'tom@example.com', '', false],
    ])('%s', (_name, list, candidate, want) => {
      process.env.FLEET_ALLOWED_EMAILS = list;
      resetFleetAccessCache();
      expect(isFleetAllowedEmail(candidate)).toBe(want);
    });

    it('refuses null and undefined rather than throwing', () => {
      process.env.FLEET_ALLOWED_EMAILS = 'tom@example.com';
      resetFleetAccessCache();
      expect(isFleetAllowedEmail(null)).toBe(false);
      expect(isFleetAllowedEmail(undefined)).toBe(false);
    });

    it('picks up a change to the env without a restart', () => {
      process.env.FLEET_ALLOWED_EMAILS = 'a@x.com';
      resetFleetAccessCache();
      expect(isFleetAllowedEmail('b@x.com')).toBe(false);

      process.env.FLEET_ALLOWED_EMAILS = 'a@x.com,b@x.com';
      // Deliberately NO cache reset: the cache keys on the raw string, so a
      // changed env has to invalidate it by itself. Caching the parse but not
      // the source would mean an operator adding an address sees nothing happen.
      expect(isFleetAllowedEmail('b@x.com')).toBe(true);
    });
  });

  describe('fleetRefusalReason', () => {
    it('distinguishes "nobody is configured" from "you are not on the list"', () => {
      delete process.env.FLEET_ALLOWED_EMAILS;
      resetFleetAccessCache();
      const unconfigured = fleetRefusalReason();
      expect(unconfigured).toContain('FLEET_ALLOWED_EMAILS');

      process.env.FLEET_ALLOWED_EMAILS = 'tom@example.com';
      resetFleetAccessCache();
      const notAllowed = fleetRefusalReason();
      expect(notAllowed).not.toContain('FLEET_ALLOWED_EMAILS');
      // One is a deployment that forgot its config, the other is working as
      // intended. Reading either as the other is an hour of debugging.
      expect(notAllowed).not.toBe(unconfigured);
    });
  });

  describe('workspaceMayUseFleet', () => {
    async function seed(ownerEmail: string): Promise<string> {
      const { db, cleanup: teardown } = await createTestDb();
      cleanup = teardown;
      const ownerId = uuid();
      const workspaceId = uuid();
      await db.insert(usersTable).values({ id: ownerId, email: ownerEmail });
      await db.insert(workspacesTable).values({
        id: workspaceId,
        ownerId,
        name: 'ws',
      });
      return workspaceId;
    }

    it('allows a workspace whose owner is on the list, and refuses one whose owner is not', async () => {
      const allowed = await seed('tom@example.com');
      process.env.FLEET_ALLOWED_EMAILS = 'tom@example.com';
      resetFleetAccessCache();
      expect(await workspaceMayUseFleet(allowed)).toBe(true);

      // Same database, same allowlist, different owner.
      process.env.FLEET_ALLOWED_EMAILS = 'someone-else@example.com';
      resetFleetAccessCache();
      expect(await workspaceMayUseFleet(allowed)).toBe(false);
    });

    it('refuses when the allowlist is empty, whoever owns the workspace', async () => {
      const ws = await seed('tom@example.com');
      delete process.env.FLEET_ALLOWED_EMAILS;
      resetFleetAccessCache();
      expect(await workspaceMayUseFleet(ws)).toBe(false);
    });

    it('refuses a workspace that does not exist', async () => {
      await seed('tom@example.com');
      process.env.FLEET_ALLOWED_EMAILS = 'tom@example.com';
      resetFleetAccessCache();
      // An unknown workspace id must not resolve to "allowed" through an empty
      // join result — which is exactly what a truthy check on rows[0] would do
      // if it were written the other way round.
      expect(await workspaceMayUseFleet(uuid())).toBe(false);
    });
  });
});
