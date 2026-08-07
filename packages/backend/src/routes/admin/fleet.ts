import { Router, type NextFunction, type Request, type Response } from 'express';
import type {
  AdminFleetHostDetail,
  AdminGoldensView,
  AdminIncident,
  AdminRebakeStatus,
  AdminRunDetail,
  AdminRunEventPage,
  ApiResponse,
} from '@talyn/shared';
import {
  fleetClientForHost,
  handleFleetProxyError,
  listAdminFleetHosts,
  probe,
  toAdminHost,
} from '../../services/admin/fleetProxy.js';
import { adminRunFromFleet, listAdminRuns } from '../../services/admin/runIndex.js';
import { listFleetIncidents } from '../../services/admin/incidents.js';
import { getFleetHost } from '../../services/fleetHosts.js';
import {
  ADMIN_SLOW_MUTATION_TIMEOUT_MS,
} from '../../services/admin/fleetProxy.js';
import {
  auditActor,
  fleetActorFields,
  withRemoteAudit,
} from '../../services/admin/audit.js';
import {
  adminReason,
  AdminGuardError,
  adminMutationLimit,
  requireReason,
  withGuards,
} from './guards.js';
import { ADMIN_FLEET_UNREACHABLE, SSE_KEEPALIVE_FRAME, formatSseFrame } from '@talyn/shared';
import { FleetRunNotFoundError } from '../../services/selfHosted/client.js';

/**
 * Fleet reads for the operator console.
 *
 * Everything here is a proxy to fleetd over the private link, and everything
 * here degrades rather than fails — see services/admin/fleetProxy.ts for the
 * contract. The short version: this is the page you open BECAUSE a host is
 * misbehaving, so a dead box must render as a row with a reason, never as a
 * failed request.
 */
/**
 * `withGuards`, plus the fleet's own error mapping.
 *
 * A mutation that could not reach the host must not surface as a generic 500
 * — that reads as "Talyn is broken" when the accurate statement is "the box
 * did not answer", and the two lead an operator to do completely different
 * things. HostOffline/NotDialable keep their 409s; anything else upstream
 * becomes a 502.
 */
function withFleetGuards(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return withGuards(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof AdminGuardError) throw err;
      if (handleFleetProxyError(err, res)) return;
      res.status(502).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        code: ADMIN_FLEET_UNREACHABLE,
      });
    }
  });
}

export function adminFleetRoutes(): Router {
  const router = Router();

  /**
   * The host list.
   *
   * `?live=1` enriches each row with a fresh capacity read. Without it this
   * answers from the registry alone and dials nothing — which is what the
   * console's first paint uses, because a page that waits on N tailnet round
   * trips before showing anything is unusable during the incident it was
   * opened for.
   */
  router.get('/hosts', async (req, res) => {
    const live = req.query.live === '1' || req.query.live === 'true';
    const hosts = await listAdminFleetHosts({ live });
    res.json({ success: true, data: hosts } as ApiResponse<typeof hosts>);
  });

  /**
   * One host, with whatever live detail we can get.
   *
   * Still 200 when the host is unreachable: an operator who explicitly asked
   * about hetzner-64 wants "last seen 4 minutes ago, unreachable", not a 502
   * that tells them nothing about the box.
   */
  router.get('/hosts/:name', async (req, res) => {
    const host = await getFleetHost(req.params.name);
    if (!host) {
      res.status(404).json({ success: false, error: 'Host not found', code: 'host_unknown' });
      return;
    }

    const base = toAdminHost(host);
    const stats = await probe(host.name, (client) => client.stats());
    const detail: AdminFleetHostDetail = {
      ...base,
      // The registry's last stored snapshot — present even when the host is
      // down, which is the whole reason hosts push rather than us scraping.
      metrics: (host.metrics ?? null) as AdminFleetHostDetail['metrics'],
      liveMetrics: null,
      runsByStatus: null,
    };

    if (stats.ok) {
      detail.live = {
        draining: stats.value.host.draining,
        runsLive: stats.value.host.runsLive,
        runsMax: stats.value.host.runsMax,
        memReservedMib: stats.value.host.memReservedMib,
        memBudgetMib: stats.value.host.memBudgetMib,
        // /v1/stats has no `accepting`; derive it the way /v1/capacity does.
        accepting: !stats.value.host.draining && stats.value.host.runsLive < stats.value.host.runsMax,
      };
      detail.liveMetrics = stats.value.metrics ?? null;
      detail.runsByStatus = stats.value.runsByStatus ?? null;
    } else {
      detail.liveError = stats.error;
      detail.liveErrorCode = stats.code;
    }

    res.json({ success: true, data: detail } as ApiResponse<AdminFleetHostDetail>);
  });

  /** The Prometheus scrape, passed through as text. */
  router.get('/hosts/:name/metrics', async (req, res) => {
    try {
      const { client } = await fleetClientForHost(req.params.name);
      const text = await client.metricsText();
      res.type('text/plain').send(text);
    } catch (err) {
      if (!handleFleetProxyError(err, res)) {
        res.status(502).json({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'fleet_unreachable',
        });
      }
    }
  });

  /**
   * Runs: the durable `tasks` page left-joined with every online host's live
   * list. See services/admin/runIndex.ts — the orphan rows are the point.
   */
  router.get('/runs', async (req, res) => {
    const index = await listAdminRuns({
      host: req.query.host,
      status: req.query.status,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: index } as ApiResponse<typeof index>);
  });

  router.get('/hosts/:name/runs/:runId', async (req, res) => {
    try {
      const { client } = await fleetClientForHost(req.params.name);
      const { run, terminal } = await client.getRun(req.params.runId);
      // Mapped to the SAME row shape the list uses, so the detail page does
      // not reimplement idle time, wedge detection and the status pill
      // against a second set of field names.
      const data: AdminRunDetail = {
        run: adminRunFromFleet(run, req.params.name),
        terminal,
      };
      res.json({ success: true, data } as ApiResponse<AdminRunDetail>);
    } catch (err) {
      if (!handleFleetProxyError(err, res)) {
        res.status(502).json({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'fleet_unreachable',
        });
      }
    }
  });

  /** A run's transcript, by cursor. The stream endpoint is the live twin. */
  router.get('/hosts/:name/runs/:runId/events', async (req, res) => {
    const after = Number(req.query.after);
    const limit = Number(req.query.limit);
    try {
      const { client } = await fleetClientForHost(req.params.name);
      const page = await client.getEvents(
        req.params.runId,
        Number.isFinite(after) && after > 0 ? after : 0,
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : undefined
      );
      res.json({ success: true, data: page } as ApiResponse<AdminRunEventPage>);
    } catch (err) {
      if (!handleFleetProxyError(err, res)) {
        res.status(502).json({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'fleet_unreachable',
        });
      }
    }
  });

  router.get('/hosts/:name/goldens', async (req, res) => {
    try {
      const { client } = await fleetClientForHost(req.params.name);
      const view = await client.listGoldens();
      const data: AdminGoldensView = {
        goldens: (view.goldens ?? []).map((g) => ({
          key: g.key,
          path: g.path,
          // The fleet keys base images under a distinct prefix; anything with
          // a repo slug is a per-repo layer.
          layer: g.repoSlug ? 'repo' : 'base',
          contentSha: g.contentSha || null,
          repoSlug: g.repoSlug || null,
          baseBranch: g.baseBranch || null,
          repoCommit: g.repoCommit || null,
          packageManager: g.packageManager || null,
          builtAt: g.builtAt || null,
          apparentBytes: g.apparentBytes ?? 0,
          diskBytes: g.diskBytes ?? 0,
          inUse: Boolean(g.inUse),
          operatorPinned: Boolean(g.operatorPinned),
          selectable: Boolean(g.selectable),
        })),
        baseGolden: view.baseGolden || null,
        baseOsSha: view.baseOsSha || null,
        freePct: typeof view.freePct === 'number' ? view.freePct : null,
      };
      res.json({ success: true, data } as ApiResponse<AdminGoldensView>);
    } catch (err) {
      if (!handleFleetProxyError(err, res)) {
        res.status(502).json({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'fleet_unreachable',
        });
      }
    }
  });

  router.get('/hosts/:name/goldens/rebake', async (req, res) => {
    try {
      const { client } = await fleetClientForHost(req.params.name);
      const status = await client.getRebake();
      const data: AdminRebakeStatus = {
        slug: status.slug ?? null,
        baseBranch: status.baseBranch ?? null,
        actor: status.actor ?? null,
        reason: status.reason ?? null,
        startedAt: status.startedAt ?? null,
        finishedAt: status.finishedAt ?? null,
        error: status.error ?? null,
      };
      res.json({ success: true, data } as ApiResponse<AdminRebakeStatus>);
    } catch (err) {
      if (!handleFleetProxyError(err, res)) {
        res.status(502).json({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'fleet_unreachable',
        });
      }
    }
  });

  /**
   * A run's transcript as a live stream.
   *
   * Proxies fleetd's own SSE follow. Three things here are not optional:
   *
   *  - A keepalive every 15s. Railway's edge reaps idle connections, and
   *    fleetd's own `: ping` is consumed by our parser rather than forwarded,
   *    so without this the stream dies after ~60s of a quiet agent — which
   *    looks exactly like the run having stopped.
   *  - Aborting upstream when the client disconnects. Otherwise every closed
   *    tab leaks a connection to a fleet host for the life of the run.
   *  - Ending, not 502-ing, on a mid-stream failure. The headers went out with
   *    the first byte; there is no status left to change, so the failure has to
   *    travel as a frame.
   */
  router.get('/hosts/:name/runs/:runId/stream', async (req, res) => {
    const after = Number(req.query.after);
    let client;
    try {
      ({ client } = await fleetClientForHost(req.params.name));
    } catch (err) {
      if (!handleFleetProxyError(err, res)) {
        res.status(502).json({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'fleet_unreachable',
        });
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells any buffering proxy in front of us to stop buffering. Without
      // it an edge can hold frames until the response ends, which for a
      // stream is never.
      'X-Accel-Buffering': 'no',
    });

    const controller = new AbortController();
    const keepalive = setInterval(() => res.write(SSE_KEEPALIVE_FRAME), 15_000);
    // A stream is not a subscription for life: cap it so a forgotten tab
    // cannot pin a fleet connection indefinitely. The browser reconnects from
    // its cursor.
    const cap = setTimeout(() => controller.abort(), 30 * 60_000);
    const stop = () => {
      clearInterval(keepalive);
      clearTimeout(cap);
      controller.abort();
    };
    req.on('close', stop);

    try {
      for await (const frame of client.followEvents(
        req.params.runId,
        Number.isFinite(after) && after > 0 ? after : 0,
        controller.signal
      )) {
        res.write(formatSseFrame(frame));
        if (frame.terminal) break;
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        res.write(formatSseFrame({ error: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      stop();
      res.end();
    }
  });

  // --------------------------------------------------------------------
  // Mutations
  //
  // Every one is addressed to ONE named host. A fan-out mutation with a single
  // shared `reason` produces N audit rows from one click with no way to tell
  // which host actually accepted it.
  //
  // These do NOT degrade: an unreachable host is an error, because "the drain
  // probably worked" is how a box stays live through an incident somebody
  // believes they drained. That is the deliberate exception to the read-side
  // contract in services/admin/fleetProxy.ts.
  // --------------------------------------------------------------------

  const limit = adminMutationLimit();

  /** Stop (or resume) a host taking new work. */
  router.post(
    '/hosts/:name/drain',
    limit,
    requireReason,
    withFleetGuards(async (req, res) => {
      const body = req.body as { draining?: unknown };
      if (typeof body.draining !== 'boolean') {
        throw new AdminGuardError(400, 'invalid_request', 'draining must be a boolean.');
      }
      const actor = auditActor(req);
      const reason = adminReason(req);

      await withRemoteAudit(
        actor,
        {
          action: 'fleet.drain',
          targetKind: 'host',
          targetId: req.params.name,
          reason,
          params: { draining: body.draining },
        },
        async () => {
          const { client } = await fleetClientForHost(req.params.name);
          await client.setDrain({ draining: body.draining as boolean, ...fleetActorFields(actor, reason) });
        }
      );
      res.json({ success: true, data: { draining: body.draining } });
    })
  );

  /** Cancel one run on a host. */
  router.post(
    '/hosts/:name/runs/:runId/cancel',
    limit,
    requireReason,
    withFleetGuards(async (req, res) => {
      await withRemoteAudit(
        auditActor(req),
        {
          action: 'fleet.run.cancel',
          targetKind: 'run',
          targetId: req.params.runId,
          reason: adminReason(req),
          params: { host: req.params.name },
        },
        async () => {
          const { client } = await fleetClientForHost(req.params.name);
          try {
            await client.cancelRun(req.params.runId);
          } catch (err) {
            // A run the host does not have cannot be cancelled, and reporting
            // that as a failure leaves the operator pressing a button that can
            // never succeed on a row they can plainly see. The intent — "make
            // this go away" — is satisfiable: the run is already gone. So this
            // resolves rather than 502s, and the audit row still records the
            // attempt (settled by withRemoteAudit either way).
            if (!(err instanceof FleetRunNotFoundError)) throw err;
            console.warn(
              `[admin] cancel ${req.params.runId} on ${req.params.name}: run already gone — ` +
                'nothing to cancel on the host',
            );
          }
        }
      );
      res.json({ success: true, data: { cancelled: true } });
    })
  );

  /** Reclaim golden-image disk. Slow — GC walks the store. */
  router.post(
    '/hosts/:name/goldens/gc',
    limit,
    requireReason,
    withFleetGuards(async (req, res) => {
      const body = req.body as { force?: boolean; dryRun?: boolean; minAge?: string };
      const actor = auditActor(req);
      const reason = adminReason(req);

      const result = await withRemoteAudit(
        actor,
        {
          action: 'fleet.golden.gc',
          targetKind: 'host',
          targetId: req.params.name,
          reason,
          params: { force: body.force ?? false, dryRun: body.dryRun ?? false, minAge: body.minAge ?? null },
        },
        async () => {
          const { client } = await fleetClientForHost(req.params.name, {
            timeoutMs: ADMIN_SLOW_MUTATION_TIMEOUT_MS,
          });
          return client.goldensGc({
            force: body.force,
            dryRun: body.dryRun,
            minAge: body.minAge,
            ...fleetActorFields(actor, reason),
          });
        }
      );
      res.json({ success: true, data: result });
    })
  );

  /** Pin an image so GC never evicts it (or unpin it). */
  router.post(
    '/hosts/:name/goldens/pin',
    limit,
    requireReason,
    withFleetGuards(async (req, res) => {
      const body = req.body as { path?: unknown; pinned?: unknown };
      if (typeof body.path !== 'string' || !body.path) {
        throw new AdminGuardError(400, 'invalid_request', 'path is required.');
      }
      if (typeof body.pinned !== 'boolean') {
        throw new AdminGuardError(400, 'invalid_request', 'pinned must be a boolean.');
      }
      const actor = auditActor(req);
      const reason = adminReason(req);

      await withRemoteAudit(
        actor,
        {
          action: 'fleet.golden.pin',
          targetKind: 'golden',
          targetId: body.path,
          reason,
          params: { host: req.params.name, pinned: body.pinned },
        },
        async () => {
          const { client } = await fleetClientForHost(req.params.name);
          await client.goldensPin({
            path: body.path as string,
            pinned: body.pinned as boolean,
            ...fleetActorFields(actor, reason),
          });
        }
      );
      res.json({ success: true, data: { path: body.path, pinned: body.pinned } });
    })
  );

  /**
   * Delete ONE golden by name.
   *
   * Distinct from GC on purpose. The fleet's GC never evicts the newest image
   * for a repo, because doing so makes the next run on that repo clone from
   * scratch — a rule with no notion of a repo we are done with, so a retired
   * repo's last golden is protected forever at any disk pressure. An operator
   * naming a single image is making exactly the judgement the GC cannot.
   *
   * The fleet still refuses the two cases that are damage rather than waste (a
   * live run reflinked from it, an operator pin), and those come back as the
   * upstream 409 rather than being pre-empted here: fleetd owns that state and
   * a second copy of the rule in this file would be one that drifts.
   */
  router.post(
    '/hosts/:name/goldens/delete',
    limit,
    requireReason,
    withFleetGuards(async (req, res) => {
      const body = req.body as { path?: unknown };
      if (typeof body.path !== 'string' || !body.path) {
        throw new AdminGuardError(400, 'invalid_request', 'path is required.');
      }
      const actor = auditActor(req);
      const reason = adminReason(req);

      const result = await withRemoteAudit(
        actor,
        {
          action: 'fleet.golden.delete',
          targetKind: 'golden',
          targetId: body.path,
          reason,
          params: { host: req.params.name },
        },
        async () => {
          const { client } = await fleetClientForHost(req.params.name);
          return client.goldensDelete({
            path: body.path as string,
            ...fleetActorFields(actor, reason),
          });
        }
      );
      res.json({ success: true, data: result });
    })
  );

  /** Rebuild a repo's golden. Slow, and async on the fleet's side. */
  router.post(
    '/hosts/:name/goldens/rebake',
    limit,
    requireReason,
    withFleetGuards(async (req, res) => {
      const body = req.body as { repo?: unknown; baseBranch?: unknown };
      if (typeof body.repo !== 'string' || !body.repo) {
        throw new AdminGuardError(400, 'invalid_request', 'repo is required.');
      }
      const actor = auditActor(req);
      const reason = adminReason(req);

      const result = await withRemoteAudit(
        actor,
        {
          action: 'fleet.golden.rebake',
          targetKind: 'golden',
          targetId: body.repo,
          reason,
          params: { host: req.params.name, baseBranch: body.baseBranch ?? null },
        },
        async () => {
          const { client } = await fleetClientForHost(req.params.name, {
            timeoutMs: ADMIN_SLOW_MUTATION_TIMEOUT_MS,
          });
          return client.goldensRebake({
            repo: body.repo as string,
            baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
            ...fleetActorFields(actor, reason),
          });
        }
      );
      res.json({ success: true, data: result });
    })
  );

  /** Derived signals, computed from the registry — no table. */
  router.get('/incidents', async (_req, res) => {
    const incidents = await listFleetIncidents();
    res.json({ success: true, data: incidents } as ApiResponse<AdminIncident[]>);
  });

  return router;
}
