import React, { useState } from 'react';
import { AlertTriangle, Github, Loader2, Plus, Settings } from 'lucide-react';
import { Button } from '../ui/button';
import { useWorkspaceStore } from '../../stores/workspace';
import { openGithubAppFlow, uncoveredOwners, formatOwnerList } from '../../lib/githubInstall';

/** One warning row in the global banner. */
function BannerRow({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

/**
 * App-wide banner surfacing missing core functionality — currently a
 * disconnected GitHub, which silently pauses PR tracking, reviews, and the
 * merge queue. Renders nothing when everything's healthy. Designed to be
 * extended: push more rows as other core services gain hard requirements.
 */
export function SystemStatusBanner() {
  const { currentWorkspaceId, githubStatus, githubInstallations, repositories, setActivePanel } =
    useWorkspaceStore();
  const [connecting, setConnecting] = useState(false);
  const [installing, setInstalling] = useState(false);

  async function handleConnect() {
    if (!currentWorkspaceId) return;
    setConnecting(true);
    try {
      // The GitHub App install runs in the system browser; useSystemStatus
      // re-checks on focus when the user returns, which clears this banner.
      await openGithubAppFlow(currentWorkspaceId, 'connect');
    } catch {
      // Nothing to do — the banner persists until the connection succeeds.
    } finally {
      setConnecting(false);
    }
  }

  async function handleInstallApp() {
    if (!currentWorkspaceId) return;
    setInstalling(true);
    try {
      await openGithubAppFlow(currentWorkspaceId, 'manage');
    } catch {
      // Banner persists until the install lands + the focus re-check runs.
    } finally {
      setInstalling(false);
    }
  }

  const rows: React.ReactNode[] = [];

  // GitHub — the core of the app. `githubStatus === null` means "not checked
  // yet", so we don't flash a banner before the first status load resolves.
  if (currentWorkspaceId && githubStatus && !githubStatus.connected) {
    rows.push(
      githubStatus.configured === false ? (
        <BannerRow
          key="gh-unconfigured"
          message="GitHub OAuth isn't configured on the backend — PR tracking is unavailable until GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set."
        />
      ) : (
        <BannerRow
          key="gh-disconnected"
          message="GitHub isn't connected for this workspace. PR tracking, reviews, and the merge queue are paused."
          action={
            <>
              <Button size="sm" onClick={handleConnect} disabled={connecting}>
                {connecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Github className="mr-1 h-4 w-4" />
                    Connect GitHub
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setActivePanel('settings')}
                title="GitHub settings"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </>
          }
        />
      )
    );
  }

  // App-installation coverage — only meaningful once GitHub is connected and the
  // installation list has actually loaded (null = not checked). A watched repo
  // whose owner has no active install is silently never tracked, so surface it.
  if (currentWorkspaceId && githubStatus?.connected && githubInstallations) {
    const uncovered = uncoveredOwners(
      repositories.map((r) => r.owner),
      githubInstallations
    );
    if (uncovered.length > 0) {
      rows.push(
        <BannerRow
          key="gh-app-uncovered"
          message={`The Talyn GitHub App isn't installed on ${formatOwnerList(
            uncovered
          )} — watched repos there aren't being tracked until you install it.`}
          action={
            <>
              <Button size="sm" onClick={handleInstallApp} disabled={installing}>
                {installing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Plus className="mr-1 h-4 w-4" />
                    Install app
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setActivePanel('settings')}
                title="GitHub settings"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </>
          }
        />
      );
    }
  }

  if (rows.length === 0) return null;
  return <div className="shrink-0">{rows}</div>;
}
