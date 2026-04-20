import { useState, useCallback, useEffect, useRef } from 'react';
import { Loader2, Check, Copy, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useEnvironmentActions } from '../../hooks/useApi';
import { environments as environmentsApi } from '../../lib/api';

interface AddEnvironmentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const BACKEND_URL = process.env.FASTOWL_API_URL || 'http://localhost:4747';

/**
 * Add a remote environment.
 *
 * Local envs are managed automatically by `useLocalDaemon` on app
 * start — users never add them manually. What "add environment" means
 * now is: pair a new remote machine by minting a pairing token the
 * user pastes into a one-liner on the target VM.
 *
 * Flow:
 *   1. User picks a name.
 *   2. We POST a `remote` env, then mint a pairing token for it.
 *   3. We display the token + a copy-pasteable install command.
 *   4. We poll the env's status until the daemon on the VM pairs and
 *      the backend flips it to 'connected'.
 */
export function AddEnvironmentModal({ open, onOpenChange }: AddEnvironmentModalProps) {
  const { createEnvironment } = useEnvironmentActions();

  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [envId, setEnvId] = useState<string | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<'pending' | 'connected' | 'failed'>('pending');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const resetForm = useCallback(() => {
    setName('');
    setIsCreating(false);
    setPairingToken(null);
    setEnvId(null);
    setDaemonStatus('pending');
    setError(null);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) resetForm();
  }, [open, resetForm]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setError(null);
    setIsCreating(true);

    try {
      const env = await createEnvironment({
        name: name.trim(),
        type: 'remote',
        config: { type: 'remote' },
      });
      if (!env) throw new Error('Failed to create environment');
      setEnvId(env.id);

      const { pairingToken: token } = await environmentsApi.pairingToken(env.id);
      setPairingToken(token);

      // Poll for status — the daemon will dial in after the user runs
      // the install script on the VM. 3s cadence is a reasonable
      // balance between responsiveness and backend load.
      pollRef.current = setInterval(async () => {
        try {
          const latest = await environmentsApi.get(env.id);
          if (latest.status === 'connected') {
            setDaemonStatus('connected');
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }
        } catch {
          // Network hiccup — keep polling.
        }
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsCreating(false);
    }
  }, [name, createEnvironment]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
  }, []);

  const installOneLiner = pairingToken
    ? `curl -fsSL ${BACKEND_URL}/daemon/install.sh | bash -s -- --backend-url ${BACKEND_URL} --pairing-token ${pairingToken}`
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add remote environment</DialogTitle>
          <DialogDescription>
            Pair a new machine to FastOwl. We'll mint a one-time token; paste
            the install command on the target VM to bring up a daemon.
          </DialogDescription>
        </DialogHeader>

        {!pairingToken && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Hetzner box, Dev VM, GPU rig"
                disabled={isCreating}
              />
            </div>
            {error && (
              <div className="text-sm text-destructive flex items-start gap-2">
                <X className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {pairingToken && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Run this on the target machine
              </label>
              <div className="relative">
                <pre className="bg-muted rounded-md p-3 text-xs font-mono overflow-x-auto pr-10 whitespace-pre-wrap break-all">
                  {installOneLiner}
                </pre>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-1 right-1"
                  onClick={() => copyToClipboard(installOneLiner)}
                >
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Token expires in 10 minutes. You can re-mint one from the env's
                settings if it does.
              </p>
            </div>

            <div className="flex items-center gap-2 text-sm">
              {daemonStatus === 'pending' && (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Waiting for daemon to dial in…</span>
                </>
              )}
              {daemonStatus === 'connected' && (
                <>
                  <Check className="w-4 h-4 text-green-500" />
                  <span>Paired — the env is ready to use.</span>
                </>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {!pairingToken && (
            <>
              <Button variant="outline" onClick={handleClose} disabled={isCreating}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!name.trim() || isCreating}>
                {isCreating ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                Create & pair
              </Button>
            </>
          )}
          {pairingToken && (
            <Button onClick={handleClose}>
              {daemonStatus === 'connected' ? 'Done' : 'Close'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
