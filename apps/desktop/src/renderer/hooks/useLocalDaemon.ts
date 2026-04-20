import { useEffect, useRef } from 'react';
import { environments } from '../lib/api';

/**
 * On first authenticated load, make sure this machine has a paired
 * local daemon env. If paired, just tell main.ts to bring the daemon
 * up. If not, create the env + mint a pairing token and hand it over.
 *
 * Idempotent — runs once per renderer mount. If the daemon is already
 * running, `ensureRunning` is a no-op on the main side.
 *
 * See docs/DAEMON_EVERYWHERE.md Slice 4.
 */
export function useLocalDaemon(): void {
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    const backendUrl = process.env.FASTOWL_API_URL || 'http://localhost:4747';
    const bridge = window.electron?.daemon;
    if (!bridge) return; // running outside Electron (tests, storybook, …)

    (async () => {
      try {
        const paired = await bridge.isPaired();
        if (paired) {
          await bridge.ensureRunning({ backendUrl });
          return;
        }

        // Not paired on disk — could be first-ever launch OR a prior
        // pairing attempt that failed midway. Either way, look for an
        // existing "This Mac (<hostname>)" env before creating a new
        // one, so retries don't leave a trail of orphan envs.
        const label = await bridge.getHostLabel();
        const envName = `This Mac (${label})`;
        const existing = await environments.list();
        const match = existing.find((e) => e.name === envName && e.type === 'local');
        const envId = match
          ? match.id
          : (
              await environments.create({
                name: envName,
                type: 'local',
                config: { type: 'local', hostname: label },
                // Local envs default to strict permissions — this is
                // the user's own hardware, not a throwaway VM.
                autonomousBypassPermissions: false,
              })
            ).id;

        const { pairingToken } = await environments.pairingToken(envId);
        await bridge.configureAndStart({ backendUrl, pairingToken });
      } catch (err) {
        // Pairing failures shouldn't crash the app — user can retry
        // from a future Settings → Local daemon surface (Slice 7).
        console.error('[useLocalDaemon] pairing failed', err);
      }
    })();
  }, []);
}
