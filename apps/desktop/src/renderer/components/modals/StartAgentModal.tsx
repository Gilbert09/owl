import React, { useState, useCallback } from 'react';
import { Terminal, Server, Loader2 } from 'lucide-react';
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
import { Textarea } from '../ui/textarea';
import { useWorkspaceStore } from '../../stores/workspace';
import { useAgentActions } from '../../hooks/useApi';

interface StartAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StartAgentModal({ open, onOpenChange }: StartAgentModalProps) {
  const { environments, currentWorkspaceId } = useWorkspaceStore();
  const { startAgent } = useAgentActions();

  const [environmentId, setEnvironmentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectedEnvironments = environments.filter((e) => e.status === 'connected');

  const handleSubmit = useCallback(async () => {
    if (!environmentId) {
      setError('Please select an environment');
      return;
    }
    if (!currentWorkspaceId) {
      setError('No workspace selected. Please select a workspace first.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      console.log('Starting agent...', { environmentId, currentWorkspaceId, prompt });
      await startAgent(environmentId, currentWorkspaceId, prompt || undefined);
      console.log('Agent started successfully');
      onOpenChange(false);
      // Reset form
      setEnvironmentId('');
      setPrompt('');
    } catch (err: any) {
      console.error('Failed to start agent:', err);
      setError(err.message || 'Failed to start agent');
    } finally {
      setIsLoading(false);
    }
  }, [environmentId, currentWorkspaceId, prompt, startAgent, onOpenChange]);

  const handleClose = useCallback(() => {
    if (!isLoading) {
      onOpenChange(false);
      setError(null);
    }
  }, [isLoading, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={handleClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="w-5 h-5" />
            Start New Agent
          </DialogTitle>
          <DialogDescription>
            Start a Claude agent on one of your connected environments.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <Select
            label="Environment"
            value={environmentId}
            onChange={(e) => setEnvironmentId(e.target.value)}
            disabled={isLoading}
          >
            <option value="">Select an environment...</option>
            {connectedEnvironments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name} ({env.type})
              </option>
            ))}
          </Select>

          {!currentWorkspaceId && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-sm">
              <Server className="w-4 h-4 flex-shrink-0" />
              <span>No workspace selected. Create or select a workspace first.</span>
            </div>
          )}

          {currentWorkspaceId && connectedEnvironments.length === 0 && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-sm">
              <Server className="w-4 h-4 flex-shrink-0" />
              <span>No connected environments. Add one in Settings.</span>
            </div>
          )}

          <Textarea
            label="Initial Prompt (optional)"
            placeholder="e.g., Fix the authentication bug in login.ts"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={isLoading}
            rows={4}
          />

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
          <Button
            onClick={handleSubmit}
            disabled={!environmentId || !currentWorkspaceId || isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <Terminal className="w-4 h-4 mr-2" />
                Start Agent
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
