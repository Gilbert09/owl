import React, { useState } from 'react';
import { AlertTriangle, Check, Loader2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { GitHubInstallation } from '../../lib/api';
import { openGithubAppFlow, uncoveredOwners, formatOwnerList } from '../../lib/githubInstall';

interface GithubInstallStatusProps {
  workspaceId: string;
  installations: GitHubInstallation[];
  /** Whether installations have been loaded at least once (null in store = not yet). */
  checked: boolean;
  loading: boolean;
  /** Owners of the repos we care about tracking — flagged if their org lacks an install. */
  watchedOwners?: string[];
  /** Re-fetch installations (the parent's hook refresh). */
  onRefresh: () => void;
  /** Show a subtle "install on another account" action even when fully covered. */
  showAddAccount?: boolean;
  className?: string;
}

/**
 * Shows GitHub App installation coverage and prompts the user to install where
 * it's missing. Shared by onboarding (Connect + Watch-repos steps) and Settings.
 *
 * - Lists the accounts/orgs the App is installed on (feedback: "installed on @x").
 * - Warns when no install exists yet, or when a watched repo's owner has no
 *   active install — those repos won't be tracked until the App is added there.
 * The install flow opens on GitHub; the parent's focus-refresh picks up the
 * result when the user returns.
 */
export function GithubInstallStatus({
  workspaceId,
  installations,
  checked,
  loading,
  watchedOwners = [],
  onRefresh,
  showAddAccount = false,
  className,
}: GithubInstallStatusProps) {
  const [opening, setOpening] = useState(false);

  const active = installations.filter((i) => !i.suspended);
  const uncovered = uncoveredOwners(watchedOwners, installations);
  const noInstalls = checked && installations.length === 0;
  const showWarning = noInstalls || uncovered.length > 0;

  async function startInstall(mode: 'connect' | 'manage') {
    setOpening(true);
    try {
      await openGithubAppFlow(workspaceId, mode);
    } finally {
      setOpening(false);
    }
    onRefresh();
  }

  // Adding a NEW org once connected uses the installations page (manage); the
  // very first install (no installs yet) re-runs authorize (connect).
  const installMode: 'connect' | 'manage' = installations.length === 0 ? 'connect' : 'manage';

  if (!checked && loading && installations.length === 0) {
    return (
      <p className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking which accounts have the Talyn app…
      </p>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      {installations.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>App installed on</span>
          {installations.map((i) => (
            <Badge
              key={i.accountLogin}
              variant={i.suspended ? 'warning' : 'success'}
              className="gap-1"
              title={
                i.suspended
                  ? 'Installation suspended on GitHub'
                  : i.repositorySelection === 'selected'
                    ? 'Installed on selected repositories'
                    : 'Installed on all repositories'
              }
            >
              {i.suspended ? (
                <AlertTriangle className="h-3 w-3" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              @{i.accountLogin}
              {i.suspended ? ' · suspended' : ''}
            </Badge>
          ))}
        </div>
      )}

      {showWarning && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <p>
              {noInstalls
                ? 'The Talyn GitHub App isn’t installed on any account yet. Install it on the org or account whose repositories you want to track.'
                : `The Talyn GitHub App isn’t installed on ${formatOwnerList(uncovered)}. ${
                    watchedOwners.length === 1 || uncovered.length === 1
                      ? 'That repository won’t'
                      : 'Those repositories won’t'
                  } be tracked until you install it there.`}
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void startInstall(installMode)} disabled={opening}>
                {opening ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Plus className="mr-1 h-4 w-4" />
                    Install on GitHub
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onRefresh}
                disabled={loading}
                title="Re-check installation status"
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </div>
      )}

      {!showWarning && showAddAccount && active.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => void startInstall('manage')}
          disabled={opening}
        >
          {opening ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1 h-3.5 w-3.5" />
          )}
          Install on another account
        </Button>
      )}
    </div>
  );
}
