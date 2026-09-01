import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { eq, sql } from 'drizzle-orm';
import { setupRoutes } from './routes/index.js';
import { setupWebSocket } from './services/websocket.js';
import { initWsBus, shutdownWsBus } from './services/wsBus.js';
import { closeRedis } from './services/redis.js';
import { initWebhookIndex } from './services/webhookIndex.js';
import { webhookHeadIndex } from './services/webhookHeadIndex.js';
import { checkCountCoalescer } from './services/checkCounts.js';
import { webhookWorker } from './services/webhookWorker.js';
import { prReconcileSweep } from './services/prReconcileSweep.js';
import { handleGithubWebhook } from './routes/webhooks.js';
import { handlePolarWebhook } from './services/billing/webhook.js';
import { initDatabase } from './db/index.js';
import { getDbClient, getPoolDbClient, closeDbClient } from './db/client.js';
import { assertValidEnv } from './services/validateEnv.js';
import { createOriginPolicy } from './services/originPolicy.js';
import { billingEnabled } from './services/billing/entitlements.js';
import { migrateLegacyPlaintextCredentials } from './services/credentialMigration.js';
import { environments as environmentsTable } from './db/schema.js';
import { taskQueueService } from './services/taskQueue.js';
import { githubService } from './services/github.js';
import { prMonitorService } from './services/prMonitor.js';
import { postHogCodeStreamer } from './services/posthogCode/streamer.js';
import { registerCloudProvider } from './services/cloudProviders/registry.js';
import { postHogCodeProvider } from './services/cloudProviders/posthog/provider.js';
import { claudeCodeProvider } from './services/cloudProviders/claude/provider.js';
import { selfHostedProvider } from './services/cloudProviders/selfhosted/provider.js';
import { cloudTaskPoller } from './services/cloudProviders/poller.js';
import { prAutoMergeWatcher } from './services/prAutoMergeWatcher.js';
import { initMergeQueueTriggers } from './services/mergeQueue/triggers.js';
import { mergeQueueReconciler } from './services/mergeQueue/reconciler.js';
import { loadExternalQueueSubmitRoutes } from './services/externalQueueSubmitRoute.js';
import { dbWatchdog } from './services/dbWatchdog.js';

const PORT = process.env.PORT || 4747;

// Crash-class guards. An unhandled rejection (e.g. an un-awaited promise in a
// poll loop) kills a default Node process — log it and keep serving instead;
// the loops are all self-rearming so losing one tick is recoverable. An
// uncaught synchronous exception leaves the process in an undefined state,
// so per Node guidance we log it and exit (with a short delay so stdio
// flushes and Railway captures the stack) — Railway restarts the service.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception — exiting:', err);
  setTimeout(() => process.exit(1), 1000).unref();
  process.exitCode = 1;
});

async function main() {
  console.log('Starting FastOwl backend...');

  // Fail fast on missing/misconfigured env instead of lazy throws on the
  // first request that needs it. Reports every problem at once.
  assertValidEnv();

  // Loud, deliberate: with no Polar env the free-plan task limit is NOT
  // enforced (a paywall nobody can pay would brick task creation). Fine for
  // dev/self-hosted; a misconfigured prod shows up in the boot log.
  if (!billingEnabled()) {
    console.warn('[billing] POLAR_* env not set — plan limits are disabled');
  }

  // Initialize database + run migrations. Must complete before services
  // read any state.
  console.log('Initializing database...');
  await initDatabase();

  // Register cloud task providers before any service that dispatches or
  // polls them. PostHog Code + Claude Code (Managed Agents) today; Codex
  // slots in here with no other changes (see docs/CLOUD_PROVIDERS.md).
  registerCloudProvider(postHogCodeProvider);
  registerCloudProvider(claudeCodeProvider);

  // The self-hosted Firecracker fleet, off unless FLEET_ENABLED is set.
  //
  // Unregistered is a stronger off than a runtime branch: with the flag unset
  // `getCloudProvider('selfhosted')` returns null, so no dispatch path can
  // reach the fleet at all and nothing behaves differently from before. The
  // flag exists so turning it on is a config change rather than a deploy —
  // but the failure mode of forgetting it is "the feature is absent", not
  // "a task went somewhere unexpected".
  //
  // A workspace also has to have fleet credentials configured before the
  // provider will accept anything, so this flag alone changes nothing for
  // any existing workspace.
  if (process.env.FLEET_ENABLED === 'true') {
    registerCloudProvider(selfHostedProvider);
    console.log('[fleet] self-hosted provider registered (FLEET_ENABLED=true)');
  }

  // One-time sweep: re-encrypt any legacy plaintext credentials before the
  // services read them (the plaintext read fallbacks are gone). Per-row
  // failures are logged inside; a total failure must not block the boot.
  await migrateLegacyPlaintextCredentials().catch((err) =>
    console.error('credential migration sweep failed:', err)
  );

  // Initialize services. Each init is idempotent and DB-aware.
  console.log('Initializing services...');
  await taskQueueService.init();
  await githubService.init();
  await prMonitorService.init();
  cloudTaskPoller.init();
  prAutoMergeWatcher.init();
  // The merge queue: an event-driven pipeline (triggers) with a 60s reconciler
  // as the backstop for anything no event reached.
  initMergeQueueTriggers();
  mergeQueueReconciler.init();
  // Restore the external merge queue's submit command per repo. This is the
  // door the queue uses on a PR whose provider comment no longer names it, and
  // it used to live only in process memory — so every deploy dropped it and the
  // next submission fell to a worse door (see externalQueueSubmitRoute.ts).
  await loadExternalQueueSubmitRoutes()
    .then((n) => n > 0 && console.log(`Loaded ${n} external merge queue submit route(s)`))
    .catch((err) => console.error('submit-route load failed:', err));

  // Webhook pipeline: prime the watch index, start the Redis Stream worker, and
  // arm the low-frequency reconcile sweep. Worker is inert without REDIS_URL.
  await initWebhookIndex().catch((err) => console.error('webhook index init failed:', err));
  await webhookWorker.init();
  // Reseed the Redis head-SHA index that lets the receiver drop CI checks for
  // commits no tracked PR head points at. Inert without REDIS_URL.
  await webhookHeadIndex.init().catch((err) => console.error('webhook head index init failed:', err));
  prReconcileSweep.init();

  // Self-healing for a wedged DB pool (Supavisor backend exhaustion): after
  // ~2 min of continuously failing probes, exit(1) so Railway's ON_FAILURE
  // policy restarts us — Railway does NOT healthcheck running deploys, so
  // without this the Jul 6 incident state persists until a human restarts it.
  dbWatchdog.init();

  // Mark cloud-provider env markers connected at boot (they have no daemon
  // to dial in — they're a credential-backed delegation marker).
  await markCloudEnvironmentsConnected();

  const app = express();
  // Railway terminates TLS one proxy hop in front of us. Without this,
  // `req.ip` is the proxy's address for every request, so any per-IP rate
  // limiter collapses into one global bucket (and one abuser rate-limits
  // everyone). Exactly 1 hop — trusting more would let clients spoof
  // X-Forwarded-For.
  app.set('trust proxy', 1);
  // Who may talk to us from a browser — see services/originPolicy.ts. Read
  // once at boot: ALLOWED_ORIGINS is deployment config, not something that
  // should change under a running process.
  const originPolicy = createOriginPolicy();
  const isOriginAllowed = (origin: string | undefined) => originPolicy.isAllowed(origin);
  const isDesktopOrigin = (origin: string | undefined) => originPolicy.isDesktop(origin);
  app.use(
    cors({
      origin(origin, cb) {
        if (isOriginAllowed(origin)) return cb(null, true);
        // Deny by OMITTING the header, don't throw. Throwing lands in
        // apiErrorHandler as a 500 (plus a stack trace), which reads as "the
        // backend is broken" when the actual answer is "this origin isn't on
        // the list" — a misconfigured ALLOWED_ORIGINS was undebuggable.
        // Without the header the browser blocks the response itself, which
        // is the correct CORS semantic.
        console.warn(`CORS: rejected origin ${origin}`);
        return cb(null, false);
      },
      // Bearer-only API — no cookie is read anywhere. Saying `true` here was
      // vestigial, and would silently start sending any cookie introduced
      // later cross-origin. Keeping it false makes CSRF-immunity structural
      // rather than accidental.
      credentials: false,
      // X-Talyn-Client-Version is a non-safelisted header, so EVERY request
      // is preflighted. Without this, a browser client doubles its request
      // count against the per-IP limiter below and pays an extra RTT on
      // every call. 24h is the maximum Chrome honours.
      maxAge: 86400,
    })
  );
  // GitHub webhook receiver. MUST be mounted before express.json so the handler
  // gets the raw body for HMAC verification (signature is over the exact bytes).
  // Public — no auth header; the HMAC IS the auth. Kept tiny + fast: verify,
  // filter, enqueue, 202.
  app.post(
    '/api/v1/webhooks/github',
    express.raw({ type: () => true, limit: '5mb' }),
    (req, res) => {
      void handleGithubWebhook(req, res);
    }
  );

  // Polar (billing) webhook receiver — same raw-body/pre-json/no-auth deal as
  // the GitHub one; the standard-webhooks signature IS the auth.
  app.post(
    '/api/v1/webhooks/polar',
    express.raw({ type: () => true, limit: '1mb' }),
    (req, res) => {
      handlePolarWebhook(req, res).catch((err) => {
        console.error('[billing] polar webhook failed:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'Webhook processing failed' });
        }
      });
    }
  );

  // 2mb (vs the 100kb default) leaves comfortable room for inline
  // workspace-logo image uploads; the per-logo cap in the workspaces route is
  // the real guard.
  app.use(express.json({ limit: '2mb' }));

  // Flipped by shutdown() so the load balancer stops routing to a draining
  // replica before its sockets are torn down.
  let draining = false;

  app.get('/health', (_req, res) => {
    void (async () => {
      if (draining) {
        res.status(503).json({ status: 'draining', timestamp: new Date().toISOString() });
        return;
      }
      // Real connectivity probe (was a hardcoded 'connected'): a cheap
      // SELECT 1 on the pool, bounded so a wedged pooler can't hang the
      // health endpoint past the platform's probe timeout.
      let database = 'connected';
      try {
        await Promise.race([
          getPoolDbClient().execute(sql`select 1`),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('health db probe timed out')), 3_000).unref()
          ),
        ]);
      } catch (err) {
        console.error('health: database probe failed:', err instanceof Error ? err.message : err);
        database = 'error';
      }
      res.status(database === 'connected' ? 200 : 503).json({
        status: database === 'connected' ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        services: {
          database,
          taskQueue: 'ready',
          cloudPoller: 'ready',
          prMonitor: 'ready',
        },
      });
    })();
  });

  setupRoutes(app);

  const server = createServer(app);

  // Single user-facing WS server on `/ws`. Uses `noServer: true` + a
  // manual upgrade router so a stray non-`/ws` upgrade is cleanly closed
  // instead of crashing the ws library's auto-attached listener.
  const wss = new WebSocketServer({ noServer: true });
  setupWebSocket(wss);

  // Cross-replica WebSocket fan-out over Redis Pub/Sub. Inert (single-process
  // delivery only) when REDIS_URL is unset. Started after setupWebSocket so the
  // local-delivery callback is registered before the first remote message.
  initWsBus();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    // Reject cross-site WebSocket hijacking: a browser page on a foreign
    // origin can open a WS (no CORS preflight on upgrades), so we apply the
    // same origin gate as REST — plus the desktop app's file:// origin.
    // This is defence-in-depth only: the connection is useless until it
    // sends a valid JWT in its first frame (see services/websocket.ts), so
    // an unrecognised origin that slips through still gets nothing.
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin) && !isDesktopOrigin(origin)) {
      socket.destroy();
      return;
    }
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`FastOwl backend running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
    console.log(`Health check at http://localhost:${PORT}/health`);
  });

  const shutdown = async () => {
    if (draining) return; // double SIGTERM/SIGINT — first one is already draining
    draining = true; // /health now answers 503 so the LB stops routing here
    console.log('Shutting down...');
    dbWatchdog.shutdown();
    cloudTaskPoller.shutdown();
    prAutoMergeWatcher.shutdown();
    mergeQueueReconciler.shutdown();
    postHogCodeStreamer.shutdownAll();
    prMonitorService.shutdown();
    taskQueueService.shutdown();
    webhookWorker.shutdown();
    webhookHeadIndex.shutdown();
    // Flush any buffered check counts so an in-flight CI burst isn't lost on a
    // graceful restart (the sweep would re-derive it, but this avoids the gap).
    await checkCountCoalescer.flushAllNow().catch(() => undefined);
    prReconcileSweep.shutdown();

    // `server.close(cb)` only fires once every connection is gone — and live
    // WebSocket clients (the desktop app) never hang up on their own, so
    // without this every deploy sat out the full force-exit timeout below.
    // Ask clients to close cleanly (1001 = going away), terminate stragglers
    // shortly after, and drop idle HTTP keep-alive sockets.
    for (const client of wss.clients) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        client.terminate();
      }
    }
    setTimeout(() => {
      for (const client of wss.clients) client.terminate();
    }, 2000).unref();
    server.closeIdleConnections();

    server.close(async () => {
      await shutdownWsBus();
      await closeRedis();
      await closeDbClient();
      console.log('Goodbye!');
      process.exit(0);
    });

    setTimeout(() => {
      console.log('Forcing exit...');
      server.closeAllConnections();
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

/**
 * Cloud env markers carry no daemon — they're synthetically "connected"
 * for as long as their credentials exist. Flip any that aren't already.
 */
async function markCloudEnvironmentsConnected() {
  const db = getDbClient();
  const envs = await db.select().from(environmentsTable);
  for (const env of envs) {
    if (env.status !== 'connected') {
      await db
        .update(environmentsTable)
        .set({ status: 'connected' })
        .where(eq(environmentsTable.id, env.id));
    }
  }
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
