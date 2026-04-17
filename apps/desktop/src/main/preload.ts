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
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
