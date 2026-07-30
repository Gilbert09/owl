// Settings → Skills: manage the workspace's Talyn (platform) skills, see
// what's on this machine (~/.claude/skills) with a one-click "Save to Talyn",
// and browse the skills discovered in each watched repo.

import React, { useMemo, useState } from 'react';
import {
  Check,
  FolderGit2,
  Laptop,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import type { PlatformSkill, SkillSummary } from '@talyn/shared';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSkills } from '../../hooks/useSkills';
import { toLocalSkillSummaries } from '../../lib/skills';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

interface SkillDraft {
  id?: string;
  name: string;
  description: string;
  content: string;
}

export function SkillsSettings() {
  const { currentWorkspaceId, repositories } = useWorkspaceStore();
  const workspaceRepos = useMemo(
    () => repositories.filter((r) => r.workspaceId === currentWorkspaceId),
    [repositories, currentWorkspaceId]
  );
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const repoId = selectedRepoId ?? workspaceRepos[0]?.id ?? null;
  const { skills, localFiles, repoStatus, refreshing, refresh } = useSkills(
    currentWorkspaceId,
    repoId
  );

  const platformSkills = skills.filter((s) => s.source === 'platform');
  const repoSkills = skills.filter((s) => s.source === 'repo');
  const localSkills = useMemo(() => toLocalSkillSummaries(localFiles), [localFiles]);

  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [importingPath, setImportingPath] = useState<string | null>(null);

  async function saveDraft() {
    if (!currentWorkspaceId || !draft) return;
    if (!draft.name.trim() || !draft.content.trim()) {
      toast.error('Name and content are required');
      return;
    }
    setSaving(true);
    try {
      if (draft.id) {
        await api.skills.update(draft.id, {
          name: draft.name,
          description: draft.description,
          content: draft.content,
        });
        toast.success(`Updated "${draft.name}"`);
      } else {
        await api.skills.create({
          workspaceId: currentWorkspaceId,
          name: draft.name,
          description: draft.description,
          content: draft.content,
        });
        toast.success(`Created "${draft.name}"`);
      }
      setDraft(null);
      await refresh();
    } catch (err) {
      toast.error(
        draft.id ? 'Could not update skill' : 'Could not create skill',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setSaving(false);
    }
  }

  async function editSkill(skill: SkillSummary) {
    if (!skill.id) return;
    try {
      const full: PlatformSkill = await api.skills.get(skill.id);
      setDraft({
        id: full.id,
        name: full.name,
        description: full.description,
        content: full.content,
      });
    } catch (err) {
      toast.error('Could not load skill', err instanceof Error ? err.message : undefined);
    }
  }

  async function deleteSkill(skill: SkillSummary) {
    if (!skill.id) return;
    try {
      await api.skills.remove(skill.id);
      toast.success(`Deleted "${skill.name}"`);
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      toast.error('Could not delete skill', err instanceof Error ? err.message : undefined);
    }
  }

  async function saveLocalToTalyn(skill: SkillSummary) {
    if (!currentWorkspaceId || !skill.localPath) return;
    const file = localFiles.find((f) => f.path === skill.localPath);
    if (!file?.content) {
      toast.error('Skill file is too large to save');
      return;
    }
    setImportingPath(skill.localPath);
    try {
      await api.skills.create({
        workspaceId: currentWorkspaceId,
        name: skill.name,
        description: skill.description,
        content: file.content,
        sourceInfo: { importedFrom: 'local', originPath: skill.localPath },
      });
      toast.success(`Saved "${skill.name}" to Talyn`);
      await refresh();
    } catch (err) {
      toast.error(
        `Couldn't save "${skill.name}"`,
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setImportingPath(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Wand2 className="w-5 h-5" />
          Skills
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Agent skills (SKILL.md) you can run on a pull request with a cloud task — from this
          workspace, this machine, or the PR&apos;s repo.
        </p>
      </div>

      {/* Talyn (platform) skills */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-violet-500" />
            Talyn skills
          </h4>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => setDraft({ name: '', description: '', content: '' })}
          >
            <Plus className="w-3.5 h-3.5" /> New skill
          </Button>
        </div>
        {platformSkills.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No skills saved to Talyn yet. Create one, or save a local skill below.
          </p>
        ) : (
          <div className="space-y-1">
            {platformSkills.map((skill) => (
              <div
                key={skill.key}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{skill.name}</div>
                  {skill.description && (
                    <div className="text-xs text-muted-foreground truncate">
                      {skill.description}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  title="Edit"
                  onClick={() => void editSkill(skill)}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                {confirmDeleteId === skill.id ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 px-2 text-xs"
                    onClick={() => void deleteSkill(skill)}
                  >
                    Confirm
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600"
                    title="Delete"
                    onClick={() => setConfirmDeleteId(skill.id ?? null)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Local skills */}
      <Card className="p-4">
        <h4 className="font-medium flex items-center gap-2 mb-1">
          <Laptop className="w-4 h-4 text-muted-foreground" />
          Local skills (this machine)
        </h4>
        <p className="text-xs text-muted-foreground mb-3">
          Read from <code>~/.claude/skills</code> — ready to run on any PR straight from the
          picker, nothing to set up. Saving one to Talyn is optional and only makes it
          available from other machines.
        </p>
        {localSkills.length === 0 ? (
          <p className="text-sm text-muted-foreground">No local skills found.</p>
        ) : (
          <div className="space-y-1">
            {localSkills.map((skill) => {
              const alreadyOnTalyn = platformSkills.some((p) => p.name === skill.name);
              return (
                <div
                  key={skill.key}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{skill.name}</div>
                    {skill.description && (
                      <div className="text-xs text-muted-foreground truncate">
                        {skill.description}
                      </div>
                    )}
                  </div>
                  {alreadyOnTalyn ? (
                    <span
                      className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                      title="Also saved to Talyn"
                    >
                      <Check className="w-3 h-3" /> On Talyn
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                      disabled={importingPath === skill.localPath}
                      title="Optional — copies this skill to Talyn so it's available from other machines"
                      onClick={() => void saveLocalToTalyn(skill)}
                    >
                      {importingPath === skill.localPath ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Upload className="w-3 h-3" />
                      )}
                      Save to Talyn
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Repo skills */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium flex items-center gap-2">
            <FolderGit2 className="w-4 h-4 text-muted-foreground" />
            Repo skills
          </h4>
          <div className="flex items-center gap-2">
            {workspaceRepos.length > 1 && (
              <select
                value={repoId ?? ''}
                onChange={(e) => setSelectedRepoId(e.target.value || null)}
                className="max-w-[240px] shrink-0 rounded-md border bg-background px-2 py-1 text-xs"
              >
                {workspaceRepos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            )}
            {workspaceRepos.length === 1 && (
              <span className="text-xs text-muted-foreground">{workspaceRepos[0].fullName}</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              title="Re-fetch from GitHub"
              disabled={refreshing || !repoId}
              onClick={() => void refresh({ refreshRepo: true })}
            >
              {refreshing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
            </Button>
          </div>
        </div>
        {workspaceRepos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repositories in this workspace.</p>
        ) : repoStatus === 'error' ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Couldn&apos;t load skills from GitHub — try refreshing.
          </p>
        ) : repoSkills.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No skills in this repo (looked in <code>.claude/skills</code> on the default branch).
          </p>
        ) : (
          <div className="space-y-1">
            {repoSkills.map((skill) => (
              <div key={skill.key} className="rounded-md px-2 py-1.5 hover:bg-muted/60">
                <div className="text-sm font-medium">{skill.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {skill.description || skill.repoPath}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Create / edit dialog */}
      {draft && (
        <Dialog open onOpenChange={(o) => !o && setDraft(null)}>
          <DialogContent className="max-w-2xl" onClose={() => setDraft(null)}>
            <DialogHeader>
              <DialogTitle>{draft.id ? 'Edit skill' : 'New skill'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Name</label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="pr-review"
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <Input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What this skill does, shown in the picker"
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Content (SKILL.md)
                </label>
                <Textarea
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  placeholder={'---\nname: pr-review\ndescription: …\n---\n\nInstructions…'}
                  className="mt-1 h-64 font-mono text-xs"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void saveDraft()} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 w-3.5 h-3.5 animate-spin" />}
                {draft.id ? 'Save changes' : 'Create skill'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
