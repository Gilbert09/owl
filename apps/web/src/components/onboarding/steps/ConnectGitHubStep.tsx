import React, { useState } from 'react';
import { AlertCircle, Check, Github, Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { type GitHubStatus, type GitHubUser } from '../../../lib/api';
import { useGithubInstallations } from '../../../hooks/useGithubInstallations';
import { openGithubAppFlow } from '../../../lib/githubInstall';
import { GithubInstallStatus } from '../../widgets/GithubInstallStatus';

interface ConnectGitHubStepProps {
  workspaceId: string | null;
  status: GitHubStatus | null;
  user: GitHubUser | null;
}

/**
 * Step 2 — connect GitHub via OAuth. The flow opens in the system browser;
 * the parent's `useGithubConnection` hook re-checks status on focus and flips
 * `status.connected` when the user returns, which enables the Next button.
 */
export function ConnectGitHubStep({ workspaceId, status, user }: ConnectGitHubStepProps) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = Boolean(status?.connected);
  const configured = status?.configured !== false;
  const { installations, checked, loading, refresh } = useGithubInstallations(
    workspaceId,
    connected
  );

  async function handleConnect() {
    if (!workspaceId) return;
    setConnecting(true);
    setError(null);
    try {
      await openGithubAppFlow(workspaceId, 'connect');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the GitHub App install');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Talyn tracks your pull requests, reviews, and CI status through GitHub. Connect
        your account to continue — a browser window opens to authorize, then you're returned
        here.
      </p>

      <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
          <Github className={connected ? 'h-5 w-5 text-green-500' : 'h-5 w-5'} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">GitHub</span>
            {connected && (
              <Badge variant="default" className="bg-green-600">
                <Check className="mr-1 h-3 w-3" />
                Connected
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {connected && user ? (
              <>Connected as <strong>@{user.login}</strong></>
            ) : configured ? (
              'Not connected yet'
            ) : (
              status?.message || 'GitHub OAuth is not configured in this build'
            )}
          </p>
        </div>
        {!connected && (
          <Button onClick={handleConnect} disabled={connecting || !configured || !workspaceId}>
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
          </Button>
        )}
      </div>

      {connected && workspaceId && (
        <GithubInstallStatus
          workspaceId={workspaceId}
          installations={installations}
          checked={checked}
          loading={loading}
          onRefresh={refresh}
          showAddAccount
        />
      )}

      {!connected && (
        <p className="text-xs text-muted-foreground">
          After authorizing in your browser, return to this window — the connection is
          detected automatically. You’ll choose which org or account to install the
          Talyn app on as part of that flow.
        </p>
      )}

      {error && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </p>
      )}
    </div>
  );
}
