import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { daemonPublicRoutes } from '../../routes/daemon.js';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/daemon', daemonPublicRoutes());
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

describe('routes/daemon (public, unauthenticated)', () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    process.env = { ...originalEnv };
  });

  describe('GET /daemon/install.sh', () => {
    it('serves the install script with the shellscript content-type', async () => {
      const res = await fetch(`${serverUrl}/daemon/install.sh`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/x-shellscript/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.text();
      // The real script starts with a bash shebang + a header comment.
      expect(body.startsWith('#!/usr/bin/env bash')).toBe(true);
      expect(body).toContain('install-daemon.sh');
    });
  });

  describe('GET /daemon/latest-version', () => {
    it('returns "dev" when no build SHA env var is set', async () => {
      delete process.env.RAILWAY_GIT_COMMIT_SHA;
      delete process.env.FASTOWL_BUILD_SHA;
      delete process.env.GITHUB_SHA;
      const res = await fetch(`${serverUrl}/daemon/latest-version`);
      const body = await res.json();
      expect(body.data.version).toBe('dev');
    });

    it('returns a short Railway build SHA when set', async () => {
      process.env.RAILWAY_GIT_COMMIT_SHA = 'abc1234deadbeef';
      delete process.env.FASTOWL_BUILD_SHA;
      delete process.env.GITHUB_SHA;
      const res = await fetch(`${serverUrl}/daemon/latest-version`);
      const body = await res.json();
      expect(body.data.version).toBe('abc1234');
    });

    it('falls back to FASTOWL_BUILD_SHA then GITHUB_SHA', async () => {
      delete process.env.RAILWAY_GIT_COMMIT_SHA;
      process.env.FASTOWL_BUILD_SHA = 'fastowlshalong';
      const res = await fetch(`${serverUrl}/daemon/latest-version`);
      const body = await res.json();
      expect(body.data.version).toBe('fastowl');

      delete process.env.FASTOWL_BUILD_SHA;
      process.env.GITHUB_SHA = 'gh12345abcdef';
      const res2 = await fetch(`${serverUrl}/daemon/latest-version`);
      const body2 = await res2.json();
      expect(body2.data.version).toBe('gh12345');
    });

    it('sets no-store cache headers so stale values never stick around', async () => {
      const res = await fetch(`${serverUrl}/daemon/latest-version`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });
});
