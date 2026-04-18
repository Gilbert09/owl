import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Server, Loader2, Check, X, Copy } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Input } from '../ui/input';
import { useEnvironmentActions } from '../../hooks/useApi';
import { environments as environmentsApi } from '../../lib/api';

interface AddEnvironmentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type EnvironmentType = 'local' | 'ssh' | 'daemon';
type AuthMethod = 'key' | 'password';
type DaemonMode = 'manual' | 'ssh-install';

export function AddEnvironmentModal({ open, onOpenChange }: AddEnvironmentModalProps) {
  const { createEnvironment, testConnection } = useEnvironmentActions();

  const [type, setType] = useState<EnvironmentType>('local');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('key');
  const [keyPath, setKeyPath] = useState('~/.ssh/id_rsa');
  const [password, setPassword] = useState('');

  // Daemon-specific state
  const [daemonMode, setDaemonMode] = useState<DaemonMode>('ssh-install');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string>('');
  const [pollingEnvId, setPollingEnvId] = useState<string | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<'pending' | 'connected' | 'failed'>('pending');

  const [isLoading, setIsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const resetForm = useCallback(() => {
    setType('local');
    setName('');
    setHost('');
    setPort('22');
    setUsername('');
    setAuthMethod('key');
    setKeyPath('~/.ssh/id_rsa');
    setPassword('');
    setDaemonMode('ssh-install');
    setPrivateKey('');
    setPassphrase('');
    setPairingToken(null);
    setInstallLog('');
    setPollingEnvId(null);
    setDaemonStatus('pending');
    setTestResult(null);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (!isLoading) {
      onOpenChange(false);
      resetForm();
    }
  }, [isLoading, onOpenChange, resetForm]);

  // Poll the env list for a status change once we've kicked off a daemon install.
  useEffect(() => {
    if (!pollingEnvId) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    const tick = async () => {
      try {
        const env = await environmentsApi.get(pollingEnvId);
        if (env.status === 'connected') {
          setDaemonStatus('connected');
          setPollingEnvId(null);
        }
      } catch {
        // Ignore transient fetch errors — polling will retry.
      }
    };
    // Kick immediately, then interval.
    void tick();
    pollingRef.current = setInterval(() => { void tick(); }, 3000);
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [pollingEnvId]);

  const buildConfig = useCallback(() => {
    if (type === 'local') return { type: 'local' as const };
    if (type === 'daemon') {
      return { type: 'daemon' as const, hostname: host || undefined };
    }

    const config: any = {
      type: 'ssh' as const,
      host,
      port: parseInt(port, 10),
      username,
      authMethod,
    };
    if (authMethod === 'key') config.keyPath = keyPath;
    else config.password = password;
    return config;
  }, [type, host, port, username, authMethod, keyPath, password]);

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);
    setError(null);

    try {
      const tempEnv = await createEnvironment({
        name: name || 'Test',
        type,
        config: buildConfig(),
      });
      const result = await testConnection(tempEnv.id);
      setTestResult(result.connected ? 'success' : 'failed');
    } catch (err: any) {
      setTestResult('failed');
      setError(err.message || 'Connection test failed');
    } finally {
      setIsTesting(false);
    }
  }, [name, type, buildConfig, createEnvironment, testConnection]);

  /**
   * Daemon path: always creates the env first, mints a pairing token,
   * then either (a) returns the manual install command or (b) drives
   * SSH install against the remote host and polls for the daemon to
   * dial back.
   */
  const handleDaemonSubmit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setInstallLog('');

    try {
      const env = await createEnvironment({
        name,
        type: 'daemon',
        config: buildConfig(),
      });

      if (daemonMode === 'manual') {
        const tok = await environmentsApi.pairingToken(env.id);
        setPairingToken(tok.pairingToken);
        setPollingEnvId(env.id);
        return;
      }

      // SSH-install path. Backend does the SSH + curl|bash for us.
      if (!host || !username) {
        setError('Host and username required for SSH install');
        return;
      }
      if (authMethod === 'password' && !password) {
        setError('Password required');
        return;
      }
      if (authMethod === 'key' && !privateKey) {
        setError('Paste your private key contents');
        return;
      }

      const result = await environmentsApi.installDaemon(env.id, {
        host,
        port: parseInt(port, 10) || 22,
        username,
        authMethod: authMethod === 'key' ? 'privateKey' : 'password',
        password: authMethod === 'password' ? password : undefined,
        privateKey: authMethod === 'key' ? privateKey : undefined,
        passphrase: passphrase || undefined,
      });
      setInstallLog(result.log);
      setPollingEnvId(env.id);
    } catch (err: any) {
      setError(err.message || 'Daemon install failed');
      setDaemonStatus('failed');
    } finally {
      setIsLoading(false);
    }
  }, [
    name,
    daemonMode,
    buildConfig,
    createEnvironment,
    host,
    port,
    username,
    authMethod,
    password,
    privateKey,
    passphrase,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!name) {
      setError('Name is required');
      return;
    }

    if (type === 'daemon') {
      await handleDaemonSubmit();
      return;
    }

    if (type === 'ssh' && (!host || !username)) {
      setError('Host and username are required for SSH');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await createEnvironment({
        name,
        type,
        config: buildConfig(),
      });
      onOpenChange(false);
      resetForm();
    } catch (err: any) {
      setError(err.message || 'Failed to create environment');
    } finally {
      setIsLoading(false);
    }
  }, [
    name,
    type,
    host,
    username,
    buildConfig,
    createEnvironment,
    onOpenChange,
    resetForm,
    handleDaemonSubmit,
  ]);

  const publicBackendUrl =
    (process.env.FASTOWL_API_URL as string | undefined) || 'http://localhost:4747';

  const manualInstallCommand = pairingToken
    ? `curl -fsSL ${publicBackendUrl}/daemon/install.sh | bash -s -- --backend-url ${publicBackendUrl} --pairing-token ${pairingToken}`
    : '';

  const copyCommand = useCallback(async () => {
    if (manualInstallCommand) {
      await navigator.clipboard.writeText(manualInstallCommand);
    }
  }, [manualInstallCommand]);

  const isValid =
    name &&
    (type === 'local' ||
      (type === 'ssh' && host && username) ||
      (type === 'daemon' &&
        (daemonMode === 'manual' ||
          (host && username && ((authMethod === 'key' && privateKey) || (authMethod === 'password' && password))))));

  const showingPairingScreen = type === 'daemon' && (pairingToken || pollingEnvId);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={handleClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="w-5 h-5" />
            Add Environment
          </DialogTitle>
          <DialogDescription>
            Add a new environment where Claude agents can run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!showingPairingScreen && (
            <>
              <Input
                label="Name"
                placeholder="e.g., My Local Machine or Production VM"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading}
              />

              <Select
                label="Type"
                value={type}
                onChange={(e) => setType(e.target.value as EnvironmentType)}
                disabled={isLoading}
              >
                <option value="local">Local Machine</option>
                <option value="daemon">Remote VM (FastOwl daemon)</option>
                <option value="ssh">SSH (legacy — requires local backend)</option>
              </Select>
            </>
          )}

          {type === 'daemon' && !showingPairingScreen && (
            <>
              <Select
                label="How would you like to install the daemon?"
                value={daemonMode}
                onChange={(e) => setDaemonMode(e.target.value as DaemonMode)}
                disabled={isLoading}
              >
                <option value="ssh-install">Auto-install over SSH (recommended)</option>
                <option value="manual">Show me the install command (I'll run it)</option>
              </Select>

              {daemonMode === 'ssh-install' && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <Input
                        label="Host"
                        placeholder="hostname or IP"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        disabled={isLoading}
                      />
                    </div>
                    <Input
                      label="Port"
                      type="number"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      disabled={isLoading}
                    />
                  </div>
                  <Input
                    label="Username"
                    placeholder="your SSH username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={isLoading}
                  />
                  <Select
                    label="Authentication"
                    value={authMethod}
                    onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
                    disabled={isLoading}
                  >
                    <option value="key">SSH Private Key</option>
                    <option value="password">Password</option>
                  </Select>
                  {authMethod === 'key' ? (
                    <>
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Private key (PEM contents)
                        </label>
                        <textarea
                          value={privateKey}
                          onChange={(e) => setPrivateKey(e.target.value)}
                          disabled={isLoading}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;…&#10;-----END OPENSSH PRIVATE KEY-----"
                          rows={6}
                          className="w-full px-3 py-2 rounded-md bg-background border border-input text-sm font-mono"
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          Paste the contents of your private key. It's used once for the
                          install and never stored.
                        </p>
                      </div>
                      <Input
                        label="Passphrase (optional)"
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        disabled={isLoading}
                      />
                    </>
                  ) : (
                    <Input
                      label="Password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={isLoading}
                    />
                  )}
                </>
              )}

              {daemonMode === 'manual' && (
                <div className="text-sm text-muted-foreground">
                  We'll create the daemon environment and show you a one-liner to run
                  on the target machine. The daemon dials back over WebSocket — no
                  inbound ports required.
                </div>
              )}
            </>
          )}

          {type === 'ssh' && !showingPairingScreen && (
            <>
              <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs p-2">
                Legacy SSH mode only works when the FastOwl backend runs on the same
                machine as your SSH key. For a hosted backend, use "Remote VM (FastOwl
                daemon)" instead.
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Input
                    label="Host"
                    placeholder="hostname or IP"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    disabled={isLoading}
                  />
                </div>
                <Input
                  label="Port"
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  disabled={isLoading}
                />
              </div>

              <Input
                label="Username"
                placeholder="your SSH username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isLoading}
              />

              <Select
                label="Authentication"
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
                disabled={isLoading}
              >
                <option value="key">SSH Key</option>
                <option value="password">Password</option>
              </Select>

              {authMethod === 'key' ? (
                <Input
                  label="Key Path"
                  placeholder="~/.ssh/id_rsa"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  disabled={isLoading}
                />
              ) : (
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                />
              )}

              {/* Test Connection Button */}
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={!host || !username || isTesting}
                >
                  {isTesting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    'Test Connection'
                  )}
                </Button>
                {testResult === 'success' && (
                  <span className="flex items-center gap-1 text-green-400 text-sm">
                    <Check className="w-4 h-4" /> Connected
                  </span>
                )}
                {testResult === 'failed' && (
                  <span className="flex items-center gap-1 text-red-400 text-sm">
                    <X className="w-4 h-4" /> Failed
                  </span>
                )}
              </div>
            </>
          )}

          {showingPairingScreen && (
            <div className="space-y-3">
              {daemonMode === 'manual' && pairingToken && (
                <>
                  <div className="text-sm">
                    Run the following command on the target machine (Linux/macOS):
                  </div>
                  <div className="relative">
                    <pre className="p-3 rounded-md bg-muted text-xs font-mono whitespace-pre-wrap break-all">
                      {manualInstallCommand}
                    </pre>
                    <Button
                      variant="outline"
                      size="sm"
                      className="absolute top-2 right-2"
                      onClick={copyCommand}
                    >
                      <Copy className="w-3 h-3 mr-1" /> Copy
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The token expires in 10 minutes. Once the daemon connects, this
                    environment will show as "connected" automatically.
                  </p>
                </>
              )}

              {daemonMode === 'ssh-install' && installLog && (
                <>
                  <div className="text-sm">Install log:</div>
                  <pre className="p-3 rounded-md bg-muted text-xs font-mono max-h-64 overflow-auto whitespace-pre-wrap">
                    {installLog}
                  </pre>
                </>
              )}

              <div className="flex items-center gap-2">
                {daemonStatus === 'pending' && pollingEnvId && (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />
                    <span className="text-sm">Waiting for the daemon to dial back…</span>
                  </>
                )}
                {daemonStatus === 'connected' && (
                  <>
                    <Check className="w-4 h-4 text-green-400" />
                    <span className="text-sm text-green-400">Daemon connected!</span>
                  </>
                )}
                {daemonStatus === 'failed' && (
                  <>
                    <X className="w-4 h-4 text-red-400" />
                    <span className="text-sm text-red-400">Install failed</span>
                  </>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          {showingPairingScreen ? (
            <>
              {daemonStatus !== 'connected' && (
                <Button variant="outline" onClick={handleClose} disabled={isLoading}>
                  Close (daemon will still connect in the background)
                </Button>
              )}
              {daemonStatus === 'connected' && (
                <Button onClick={handleClose}>
                  <Check className="w-4 h-4 mr-2" />
                  Done
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose} disabled={isLoading}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!isValid || isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {type === 'daemon' && daemonMode === 'ssh-install'
                      ? 'Installing…'
                      : 'Adding…'}
                  </>
                ) : (
                  <>
                    <Server className="w-4 h-4 mr-2" />
                    {type === 'daemon' && daemonMode === 'ssh-install'
                      ? 'Install daemon'
                      : type === 'daemon'
                        ? 'Generate install command'
                        : 'Add Environment'}
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
