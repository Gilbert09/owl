import { Router } from 'express';
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

/**
 * Fleet reads for the operator console.
 *
 * Everything here is a proxy to fleetd over the private link, and everything
 * here degrades rather than fails — see services/admin/fleetProxy.ts for the
 * contract. The short version: this is the page you open BECAUSE a host is
 * misbehaving, so a dead box must render as a row with a reason, never as a
 * failed request.
 */
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

  /** Derived signals, computed from the registry — no table. */
  router.get('/incidents', async (_req, res) => {
    const incidents = await listFleetIncidents();
    res.json({ success: true, data: incidents } as ApiResponse<AdminIncident[]>);
  });

  return router;
}
