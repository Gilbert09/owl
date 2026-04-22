// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type Channels = 'ipc-example';

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
  },
  auth: {
    /** Open an OAuth URL in the user's default browser. */
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke('auth:open-external', url);
    },
    /**
     * Subscribe to `fastowl://auth-callback` deep links. Also flushes any
     * callback that arrived before the renderer subscribed (common on
     * macOS when the app launches from a click in the browser).
     */
    onCallback(cb: (url: string) => void): () => void {
      const handler = (_e: IpcRendererEvent, url: string) => cb(url);
      ipcRenderer.on('auth:callback', handler);
      // Drain any queued callback from before we subscribed.
      ipcRenderer.invoke('auth:drain-pending').then((url?: string | null) => {
        if (url) cb(url);
      });
      return () => ipcRenderer.removeListener('auth:callback', handler);
    },
    /**
     * safeStorage-backed key/value store used as Supabase's session
     * storage. All three methods cross into the main process; the
     * ciphertext never rides through the renderer's localStorage.
     */
    storage: {
      getItem(key: string): Promise<string | null> {
        return ipcRenderer.invoke('auth:storage:get', key);
      },
      setItem(key: string, value: string): Promise<void> {
        return ipcRenderer.invoke('auth:storage:set', key, value);
      },
      removeItem(key: string): Promise<void> {
        return ipcRenderer.invoke('auth:storage:remove', key);
      },
    },
  },
  daemon: {
    /** Whether the daemon config on disk already has a device token (=paired). */
    isPaired(): Promise<boolean> {
      return ipcRenderer.invoke('daemon:is-paired');
    },
    /** Hostname we'd label the env with in the backend — e.g. "Tom's MacBook Pro". */
    getHostLabel(): Promise<string> {
      return ipcRenderer.invoke('daemon:host-label');
    },
    /**
     * Write the given backendUrl + pairingToken into the daemon config
     * file and start the daemon (dev child or OS service depending on
     * packaged state). Renderer calls this after it has created a
     * daemon env via REST and minted a pairing token.
     */
    configureAndStart(args: {
      backendUrl: string;
      pairingToken: string;
    }): Promise<{ started: boolean }> {
      return ipcRenderer.invoke('daemon:configure-and-start', args);
    },
    /** Already-paired path: bring the daemon up without re-pairing. */
    ensureRunning(args: {
      backendUrl: string;
    }): Promise<{ started: boolean; reason?: string }> {
      return ipcRenderer.invoke('daemon:ensure-running', args);
    },
    /** Status of the local daemon on this machine — PID, installed, running. */
    localInfo(): Promise<{
      mode: 'dev' | 'prod';
      installed: boolean;
      running: boolean;
      pid?: number;
      platform: NodeJS.Platform;
    }> {
      return ipcRenderer.invoke('daemon:local-info');
    },
    /** Restart the daemon in place (debug utility; rarely needed). */
    restart(args?: { backendUrl?: string }): Promise<{ restarted: boolean; reason?: string }> {
      return ipcRenderer.invoke('daemon:restart', args);
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
