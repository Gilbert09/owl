import React, { useState } from 'react';
import { Check, FolderKanban, Loader2, Shuffle } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { WorkspaceLogo } from '../../widgets/WorkspaceLogo';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';

/**
 * Step 1 — name the first workspace. This replaces the old silent
 * "Default Workspace" auto-create: the workspace created here is set as the
 * active one, so every later step has a `currentWorkspaceId` to act on.
 */
export function WorkspaceNameStep() {
  const { workspaces, currentWorkspaceId, addWorkspace, setCurrentWorkspace } = useWorkspaceStore();
  const created = workspaces.find((w) => w.id === currentWorkspaceId) ?? null;

  const [name, setName] = useState('');
  const [seed, setSeed] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const workspace = await api.workspaces.create({
        name: trimmed,
        logo: { kind: 'identicon', seed },
      });
      addWorkspace(workspace);
      setCurrentWorkspace(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create workspace');
    } finally {
      setSaving(false);
    }
  }

  if (created) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          A workspace groups the repos and integrations you want to manage together.
        </p>
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
          <WorkspaceLogo logo={created.logo} fallbackSeed={created.id} size={48} />
          <div className="min-w-0">
            <p className="font-medium truncate">{created.name}</p>
            <p className="text-xs text-green-600 flex items-center gap-1">
              <Check className="h-3 w-3" />
              Workspace created
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          You can rename it or add more workspaces later in Settings.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A workspace groups the repos and integrations you want to manage together — for
        example a company or team you contribute to.
      </p>
      <div className="flex items-center gap-3">
        <WorkspaceLogo logo={{ kind: 'identicon', seed }} fallbackSeed={seed} size={48} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSeed(crypto.randomUUID())}
          disabled={saving}
        >
          <Shuffle className="mr-1 h-4 w-4" />
          Shuffle logo
        </Button>
      </div>
      <div>
        <label className="text-sm font-medium">Workspace name</label>
        <div className="mt-1 flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. PostHog"
            autoFocus
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
          />
          <Button onClick={handleCreate} disabled={!name.trim() || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <>
                <FolderKanban className="mr-1 h-4 w-4" />
                Create
              </>
            )}
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
