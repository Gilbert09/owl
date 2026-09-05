// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { UpdaterEvent, UpdaterCheckResult, UpdateChannel } from './updaterEvents';
import type { CodexSignInResult } from './codexAuth';

/** A SKILL.md found under ~/.claude/skills/<dirName>/. */
export interface LocalSkillFile {
  dirName: string;
  /** Absolute path of SKILL.md on this machine. */
  path: string;
  size: number;
  mtimeMs: number;
  /** Raw file text; null when the file exceeds the size guard. */
  content: string | null;
}

const electronHandler = {
  /** OS platform, for platform-specific window chrome (macOS traffic lights). */
  platform: process.platform,
  auth: {
    /** Open an OAuth URL in the user's default browser. */
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke('auth:open-external', url);
    },
    /**
     * The deep-link redirect URL to pass to Supabase's OAuth flow. Scheme is
     * `fastowl://` in prod and `fastowl-dev://` in dev, so the callback always
     * reopens this build rather than a separately-installed one.
     */
    getRedirectUrl(): Promise<string> {
      return ipcRenderer.invoke('auth:get-redirect-url');
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
  updater: {
    /**
     * Subscribe to auto-update lifecycle events forwarded by the main
     * process. Returns an unsubscribe fn.
     */
    onEvent(cb: (event: UpdaterEvent) => void): () => void {
      const handler = (_e: IpcRendererEvent, event: UpdaterEvent) => cb(event);
      ipcRenderer.on('updater:event', handler);
      return () => ipcRenderer.removeListener('updater:event', handler);
    },
    /** Trigger a manual check for updates (no-op in dev / unpackaged). */
    check(): Promise<UpdaterCheckResult> {
      return ipcRenderer.invoke('updater:check');
    },
    /** Quit and apply a downloaded update. */
    quitAndInstall(): Promise<void> {
      return ipcRenderer.invoke('updater:quit-and-install');
    },
    /** The persisted update channel ('stable' | 'nightly'). */
    getChannel(): Promise<UpdateChannel> {
      return ipcRenderer.invoke('updater:get-channel');
    },
    /** Switch update channel; triggers an immediate re-check when packaged. */
    setChannel(channel: UpdateChannel): Promise<UpdateChannel> {
      return ipcRenderer.invoke('updater:set-channel', channel);
    },
  },
  app: {
    /** Current app version, e.g. for Settings → About. */
    getVersion(): Promise<string> {
      return ipcRenderer.invoke('app:get-version');
    },
    /** True for a local dev build — the renderer flags the UI with a DEV badge. */
    isDev(): Promise<boolean> {
      return ipcRenderer.invoke('app:is-dev');
    },
  },
  codex: {
    /**
     * Connect a ChatGPT subscription for Talyn Fleet.
     *
     * Runs the whole OAuth flow in the MAIN process, because OpenAI's Codex
     * client redirects to `http://localhost:1455/auth/callback` and only a
     * process on this machine can answer a loopback address. Resolves with the
     * token pair, which the renderer forwards to the backend through the normal
     * cloud-providers route. Desktop-only: `apps/web` pastes instead.
     */
    signIn(): Promise<CodexSignInResult> {
      return ipcRenderer.invoke('codex:sign-in');
    },
  },
  skills: {
    /**
     * List local agent skills (each ~/.claude/skills/&lt;dir&gt;/SKILL.md),
     * content included. Re-read from disk on every call — no cache, no watcher.
     */
    listLocal(): Promise<LocalSkillFile[]> {
      return ipcRenderer.invoke('skills:list-local');
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
