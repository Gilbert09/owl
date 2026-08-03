import { useEffect } from 'react';
import { api } from '../lib/api';

/**
 * Keep the WebSocket connected for as long as the console is mounted.
 *
 * A deliberately stripped version of the product apps' `useApiConnection`:
 * there is no workspace to subscribe to (this console is cross-tenant), no
 * initial data load to drive, and no reconnect-triggered refetch — pages own
 * their own polling. The socket exists for the Debug panel's live
 * `debug:event` stream and nothing else yet.
 *
 * Mounted inside the gate, so a non-operator never opens a socket at all.
 * The server would refuse to fan anything out to them anyway
 * (services/websocket.ts checks isAdmin), but not connecting is cheaper and
 * makes "one authenticated request from a non-operator" literally true.
 */
export function useWsConnection(): void {
  useEffect(() => {
    void api.ws.connect();
    return () => api.ws.disconnect();
  }, []);
}
