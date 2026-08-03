import { useEffect, useRef } from 'react';
import { api } from '../lib/api';

/**
 * Run `fn` on a genuine WS *re*connect — not the initial connect, which the
 * mount-time data loads already cover. WS broadcasts are fire-and-forget to
 * currently-open sockets, so anything that changed while the socket was down
 * is lost; components use this to refetch state they otherwise keep fresh
 * through incremental WS events.
 *
 * `fn` is read through a ref, so the latest closure runs without the
 * subscription churning on every render.
 */
export function useOnReconnect(fn: () => void): void {
  const sawDisconnectRef = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    return api.ws.on('connection:status', (payload) => {
      const connected = (payload as { connected?: boolean } | undefined)?.connected;
      if (connected === false) {
        sawDisconnectRef.current = true;
        return;
      }
      if (connected && sawDisconnectRef.current) {
        sawDisconnectRef.current = false;
        fnRef.current();
      }
    });
  }, []);
}
