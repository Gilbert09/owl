/**
 * The reason gate on every admin mutation.
 *
 * The audit log's whole value is the `reason` column — "who drained prod at
 * 2am" is answerable without it, "why" is not. So the gate has to do two
 * things, and the second is the one that rots quietly: refuse a request
 * without a reason, AND carry the accepted reason through to the row. A gate
 * that validates and then drops the value is theatre, and it looks identical
 * from the outside until somebody reads the log during an incident.
 *
 * It also refuses the near-misses — whitespace-only, a non-string, an
 * over-long one — because "required" that accepts `"   "` is not required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { ADMIN_REASON_MAX_LENGTH, ADMIN_REASON_REQUIRED } from '@talyn/shared';
import {
  adminReason,
  AdminGuardError,
  handleAdminGuardError,
  notSelf,
  requireConfirm,
  requireAdminGrantEnabled,
  requireReason,
  withGuards,
} from '../routes/admin/guards.js';

/** A server whose one route echoes back whatever the gate let through. */
async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.post(
    '/mutate',
    (req, _res, next) => {
      req.user = { id: 'user-admin', email: 'op@talyn.dev', isAdmin: true };
      next();
    },
    requireReason,
    (req: Request, res: Response) => {
      // Reading it back through adminReason() is the point: this is exactly
      // how a real handler will fetch what it writes to the audit row.
      res.json({ success: true, data: { reason: adminReason(req) } });
    }
  );
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

describe('requireReason', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const s = await makeServer();
    url = s.url;
    close = s.close;
  });
  afterEach(async () => close());

  async function post(body: unknown): Promise<Response> {
    return fetch(`${url}/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as Promise<Response>;
  }

  it.each([
    ['a missing reason', {}],
    ['an empty reason', { reason: '' }],
    ['a whitespace-only reason', { reason: '   \t\n  ' }],
    ['a non-string reason', { reason: 42 }],
    ['a null reason', { reason: null }],
    ['an object reason', { reason: { why: 'because' } }],
  ])('400s %s with code reason_required', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; success: boolean };
    expect(json.success).toBe(false);
    expect(json.code).toBe(ADMIN_REASON_REQUIRED);
  });

  it('400s a reason longer than the column is meant to hold', async () => {
    const res = await post({ reason: 'x'.repeat(ADMIN_REASON_MAX_LENGTH + 1) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(ADMIN_REASON_REQUIRED);
  });

  it('accepts a reason of exactly the maximum length', async () => {
    // Off-by-one on a boundary check is how a legitimate action gets refused
    // during the incident it was needed for.
    const reason = 'x'.repeat(ADMIN_REASON_MAX_LENGTH);
    const res = await post({ reason });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { reason: string } }).data.reason).toBe(reason);
  });

  it('carries the accepted reason through VERBATIM', async () => {
    // The assertion this file exists for. Not "a reason was present" — the
    // exact text, because that text is what someone reads six months later.
    const reason = 'hetzner-64 wedged on run talyn-abc, draining to reboot fleetd';
    const res = await post({ reason });
    expect(((await res.json()) as { data: { reason: string } }).data.reason).toBe(reason);
  });

  it('trims surrounding whitespace but preserves the interior', async () => {
    const res = await post({ reason: '  two  spaces  inside  ' });
    expect(((await res.json()) as { data: { reason: string } }).data.reason).toBe(
      'two  spaces  inside'
    );
  });
});

describe('adminReason', () => {
  it('throws if a route was wired up without the gate in front of it', () => {
    // A programming error surfaced loudly rather than an audit row written
    // with an empty reason — silence here is the failure we cannot detect
    // later.
    expect(() => adminReason({} as Request)).toThrow(/without requireReason/);
  });
});

describe('notSelf', () => {
  const me = { id: 'user-admin', email: 'op@talyn.dev', isAdmin: true };

  it('refuses when the target is the caller', () => {
    // Blocks the quiet self-comp and the "demote self, nobody can get back
    // in" foot-gun in one check.
    expect(() => notSelf({ user: me } as Request, 'user-admin')).toThrow(AdminGuardError);
    try {
      notSelf({ user: me } as Request, 'user-admin');
    } catch (err) {
      expect((err as AdminGuardError).status).toBe(403);
      expect((err as AdminGuardError).code).toBe('self_mutation_forbidden');
    }
  });

  it('allows a different target', () => {
    expect(() => notSelf({ user: me } as Request, 'user-other')).not.toThrow();
  });
});

describe('requireConfirm', () => {
  const body = (confirm: unknown) => ({ body: { confirm } }) as Request;

  it('accepts the target email typed exactly', () => {
    expect(() => requireConfirm(body('someone@example.test'), 'someone@example.test')).not.toThrow();
  });

  it('accepts a case difference — the operator is reading, not transcribing', () => {
    expect(() => requireConfirm(body('SomeOne@Example.TEST'), 'someone@example.test')).not.toThrow();
  });

  it('accepts surrounding whitespace from a paste', () => {
    expect(() => requireConfirm(body('  someone@example.test '), 'someone@example.test')).not.toThrow();
  });

  it.each([
    ['a different account', 'someone-else@example.test'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a missing field', undefined],
    ['a non-string', 12345],
    ['a prefix of the address', 'someone@example'],
  ])('refuses %s', (_label, confirm) => {
    // Each of these is a mis-click or a blind cross-site POST — neither knows
    // which specific account it is aimed at, which is the whole point.
    expect(() => requireConfirm(body(confirm), 'someone@example.test')).toThrow(AdminGuardError);
  });
});

describe('requireAdminGrantEnabled', () => {
  afterEach(() => {
    delete process.env.TALYN_ADMIN_GRANT_ENABLED;
  });

  it('refuses by default', () => {
    delete process.env.TALYN_ADMIN_GRANT_ENABLED;
    expect(() => requireAdminGrantEnabled()).toThrow(AdminGuardError);
  });

  it('allows only the exact string "1"', () => {
    process.env.TALYN_ADMIN_GRANT_ENABLED = '1';
    expect(() => requireAdminGrantEnabled()).not.toThrow();
  });

  it.each([['0'], ['true'], ['on'], ['yes'], [' 1']])('refuses %j', (value) => {
    process.env.TALYN_ADMIN_GRANT_ENABLED = value;
    expect(() => requireAdminGrantEnabled()).toThrow(AdminGuardError);
  });
});

describe('handleAdminGuardError / withGuards', () => {
  function makeRes() {
    const calls: { status: number[]; bodies: unknown[] } = { status: [], bodies: [] };
    const res = {
      status(code: number) {
        calls.status.push(code);
        return res;
      },
      json(b: unknown) {
        calls.bodies.push(b);
        return res;
      },
      calls,
    };
    return res;
  }

  it('maps an AdminGuardError to its status + code', () => {
    const res = makeRes();
    const handled = handleAdminGuardError(
      new AdminGuardError(409, 'last_admin', 'Would leave no admins.'),
      res as unknown as Response
    );
    expect(handled).toBe(true);
    expect(res.calls.status).toEqual([409]);
    expect(res.calls.bodies[0]).toEqual({
      success: false,
      error: 'Would leave no admins.',
      code: 'last_admin',
    });
  });

  it('leaves any other error alone', () => {
    // A guard handler that swallowed real errors would turn a database outage
    // into a plausible-looking 4xx.
    const res = makeRes();
    expect(handleAdminGuardError(new Error('db is on fire'), res as unknown as Response)).toBe(false);
    expect(res.calls.status).toEqual([]);
  });

  it('withGuards forwards a non-guard error to next() rather than answering', async () => {
    const res = makeRes();
    let forwarded: unknown = null;
    await withGuards(() => {
      throw new Error('db is on fire');
    })({} as Request, res as unknown as Response, (err) => {
      forwarded = err;
    });
    expect((forwarded as Error).message).toBe('db is on fire');
    expect(res.calls.status).toEqual([]);
  });

  it('withGuards answers a guard error itself', async () => {
    const res = makeRes();
    let forwarded: unknown = null;
    await withGuards(() => {
      throw new AdminGuardError(400, 'confirm_mismatch', 'nope');
    })({} as Request, res as unknown as Response, (err) => {
      forwarded = err;
    });
    expect(forwarded).toBeNull();
    expect(res.calls.status).toEqual([400]);
  });
});
