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

        const label = await bridge.getHostLabel();
        const env = await environments.create({
          name: `This Mac (${label})`,
          type: 'daemon',
          config: { type: 'daemon' },
        });
        const { pairingToken } = await environments.pairingToken(env.id);
        await bridge.configureAndStart({ backendUrl, pairingToken });
      } catch (err) {
        // Pairing failures shouldn't crash the app — user can retry
        // from a future Settings → Local daemon surface (Slice 7).
        console.error('[useLocalDaemon] pairing failed', err);
      }
    })();
  }, []);
}
