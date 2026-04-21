import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';
import { daemonRegistry } from './daemonRegistry.js';

/**
 * Backend-driven auto-update for remote daemons that the user has
 * opted into (`environments.auto_update_daemon = true`).
 *
 * Two triggers:
 *   1. A daemon reconnects (fires `daemonRegistry.on('daemon:connected')`) —
 *      we check its version against ours and, if stale, push an
 *      update_daemon op right away.
 *   2. Periodic sweep every ~15 min — same logic for every connected
 *      daemon. Catches the rare case where a daemon reconnects at
 *      exactly the wrong moment for the hello to include a refreshed
 *      version (shouldn't happen, but the sweep is cheap).
 *
 * No rollback guard yet — see ROADMAP. Because the feature is opt-in
 * per env, a bad release only affects the envs the user deliberately
 * marked auto.
 */

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

function resolveLatestBackendSha(): string {
  const sha =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.FASTOWL_BUILD_SHA ||
    process.env.GITHUB_SHA ||
    '';
  return sha.slice(0, 7);
}

class DaemonAutoUpdateService {
  private sweepTimer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();
  private attached = false;

  init(): void {
    if (this.attached) return;
    this.attached = true;

    daemonRegistry.on('daemon:connected', (environmentId: string) => {
      // Wait a beat so the register() side-effect (DB write of the new
      // daemonVersion) has settled before we read it.
      setTimeout(() => {
        void this.maybeUpdate(environmentId).catch((err) => {
          console.warn(`[autoUpdate] ${environmentId} on-connect check failed:`, err);
        });
      }, 2000);
    });

    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => {
        console.warn('[autoUpdate] sweep failed:', err);
      });
    }, SWEEP_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private async sweep(): Promise<void> {
    for (const envId of daemonRegistry.listConnected()) {
      try {
        await this.maybeUpdate(envId);
      } catch (err) {
        console.warn(`[autoUpdate] ${envId} sweep check failed:`, err);
      }
    }
  }

  private async maybeUpdate(environmentId: string): Promise<void> {
    if (this.inFlight.has(environmentId)) return;

    const latestSha = resolveLatestBackendSha();
    if (!latestSha) return; // No known backend SHA — can't compare.

    const db = getDbClient();
    const rows = await db
      .select({
        type: environmentsTable.type,
        autoUpdateDaemon: environmentsTable.autoUpdateDaemon,
        daemonVersion: environmentsTable.daemonVersion,
      })
      .from(environmentsTable)
      .where(eq(environmentsTable.id, environmentId))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    if (row.type !== 'remote') return;
    if (!row.autoUpdateDaemon) return;

    const reportedSha = row.daemonVersion?.split('+')[1];
    if (!reportedSha) return; // Never paired, nothing to compare.
    if (reportedSha === latestSha) return; // Already on latest.

    if (!daemonRegistry.isConnected(environmentId)) return;

    this.inFlight.add(environmentId);
    console.log(
      `[autoUpdate] ${environmentId} stale (${reportedSha} vs ${latestSha}); triggering update`
    );
    try {
      const result = await daemonRegistry.request<{ newSha: string; message: string }>(
        environmentId,
        { op: 'update_daemon', drainTimeoutSeconds: 30 },
        REQUEST_TIMEOUT_MS
      );
      console.log(`[autoUpdate] ${environmentId} updated → ${result.newSha}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[autoUpdate] ${environmentId} update failed: ${msg}`);
    } finally {
      this.inFlight.delete(environmentId);
    }
  }
}

export const daemonAutoUpdate = new DaemonAutoUpdateService();
