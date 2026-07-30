import React, { useState } from 'react';
import { Loader2, FolderKanban, Shuffle } from 'lucide-react';
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
import { Textarea } from '../ui/textarea';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import { api } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspace';

function randomSeed(): string {
  return crypto.randomUUID();
}

interface CreateWorkspaceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Create a new workspace. On success it's added to the store and selected as
 * the active workspace, which triggers the usual workspace-scoped data load.
 */
export function CreateWorkspaceModal({ open, onOpenChange }: CreateWorkspaceModalProps) {
  const { addWorkspace, setCurrentWorkspace } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [seed, setSeed] = useState(randomSeed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setDescription('');
    setSeed(randomSeed());
    setError(null);
  }

  function handleClose(next: boolean) {
    if (saving) return;
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const workspace = await api.workspaces.create({
        name: trimmed,
        description: description.trim() || undefined,
        logo: { kind: 'identicon', seed },
      });
      addWorkspace(workspace);
      setCurrentWorkspace(workspace.id);
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create workspace');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={() => handleClose(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderKanban className="h-5 w-5" />
            New workspace
          </DialogTitle>
          <DialogDescription>
            Group related repos and integrations. You can connect GitHub + a cloud
            provider per workspace in Settings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3">
            <WorkspaceLogo logo={{ kind: 'identicon', seed }} fallbackSeed={seed} size={48} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSeed(randomSeed())}
              disabled={saving}
            >
              <Shuffle className="mr-1 h-4 w-4" />
              Shuffle logo
            </Button>
          </div>
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. PostHog"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && !saving) void handleCreate();
              }}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Description (optional)</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this workspace for?"
              rows={2}
              className="mt-1"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create workspace'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
