import React, { useState, useCallback } from 'react';
import { Server, Loader2, Check, X } from 'lucide-react';
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

interface AddEnvironmentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type EnvironmentType = 'local' | 'ssh';
type AuthMethod = 'key' | 'password';

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

  const [isLoading, setIsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setType('local');
    setName('');
    setHost('');
    setPort('22');
    setUsername('');
    setAuthMethod('key');
    setKeyPath('~/.ssh/id_rsa');
    setPassword('');
    setTestResult(null);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (!isLoading) {
      onOpenChange(false);
      resetForm();
    }
  }, [isLoading, onOpenChange, resetForm]);

  const buildConfig = useCallback(() => {
    if (type === 'local') {
      return { type: 'local' as const };
    }

    const config: any = {
      type: 'ssh' as const,
      host,
      port: parseInt(port, 10),
      username,
      authMethod,
    };

    if (authMethod === 'key') {
      config.keyPath = keyPath;
    } else {
      config.password = password;
    }

    return config;
  }, [type, host, port, username, authMethod, keyPath, password]);

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);
    setError(null);

    try {
      // Create a temporary environment to test
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

  const handleSubmit = useCallback(async () => {
    if (!name) {
      setError('Name is required');
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
  }, [name, type, buildConfig, createEnvironment, onOpenChange, resetForm]);

  const isValid = name && (type === 'local' || (host && username));

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
            <option value="ssh">SSH Remote</option>
          </Select>

          {type === 'ssh' && (
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

          {error && (
            <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <Server className="w-4 h-4 mr-2" />
                Add Environment
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
