// Searchable skill picker for the per-PR "run a skill" action. Lists skills
// from all three sources (the PR's repo, the Talyn platform, this machine),
// most-frequently-used first, and — when the workspace default is "Ask every
// time" — follows selection with a provider step before launching.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  FolderGit2,
  Laptop,
  Loader2,
  RefreshCw,
  Settings,
  Sparkles,
  Wand2,
} from 'lucide-react';
import type { SkillSummary } from '@talyn/shared';
import type { PRRow } from '../../../lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/dialog';
import { Input } from '../../ui/input';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useSkills } from '../../../hooks/useSkills';
import { frequentlyUsedSkills, isSkillTooLarge, sortSkillsForPicker } from '../../../lib/skills';
import { toast } from '../../../stores/toast';
import { cn } from '../../../lib/utils';

const SOURCE_META: Record<SkillSummary['source'], { label: string; icon: typeof Laptop }> = {
  repo: { label: 'Repo', icon: FolderGit2 },
  platform: { label: 'Talyn', icon: Sparkles },
  local: { label: 'Local', icon: Laptop },
};

interface SkillPickerModalProps {
  row: PRRow;
  open: boolean;
  onClose: () => void;
  /** Kick off the cloud task. Resolves true when a task was actually created. */
  onLaunch: (
    row: PRRow,
    skill: SkillSummary,
    opts: { providerType?: string; localContent?: string }
  ) => Promise<boolean>;
  /** "Ask every time" → show the provider step after picking a skill. */
  taskAsk?: boolean;
  taskProviders?: { type: string; displayName: string }[];
  onOpenIntegrations?: () => void;
}

export function SkillPickerModal({
  row,
  open,
  onClose,
  onLaunch,
  taskAsk,
  taskProviders,
  onOpenIntegrations,
}: SkillPickerModalProps) {
  const { currentWorkspaceId } = useWorkspaceStore();
  const { skills, localFiles, usage, repoStatus, loading, refresh } = useSkills(
    open ? currentWorkspaceId : null,
    open ? row.repositoryId ?? null : null
  );
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [launching, setLaunching] = useState(false);
  // Set once a skill is chosen while "ask every time" — swaps the body to the
  // provider list; cleared by Back / close.
  const [pendingSkill, setPendingSkill] = useState<SkillSummary | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlighted(0);
      setPendingSkill(null);
      // Autofocus after the dialog mounts.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const sorted = useMemo(() => sortSkillsForPicker(skills, usage, query), [skills, usage, query]);
  const frequent = useMemo(
    () => (query.trim() ? [] : frequentlyUsedSkills(skills, usage)),
    [skills, usage, query]
  );

  // Flat keyboard-navigation order matching the rendered order: the
  // "Frequently used" section first, then the grouped/filtered list without
  // the skills already shown above.
  const navOrder = useMemo(() => {
    const frequentKeys = new Set(frequent.map((s) => s.key));
    return [...frequent, ...sorted.filter((s) => !frequentKeys.has(s.key))];
  }, [frequent, sorted]);

  useEffect(() => setHighlighted(0), [query, navOrder.length]);

  async function launch(skill: SkillSummary, providerType?: string) {
    if (launching || isSkillTooLarge(skill)) return;
    if (taskAsk && !providerType) {
      setPendingSkill(skill);
      return;
    }
    setLaunching(true);
    try {
      const localContent =
        skill.source === 'local'
          ? localFiles.find((f) => f.path === skill.localPath)?.content ?? undefined
          : undefined;
      const created = await onLaunch(row, skill, { providerType, localContent });
      if (created) {
        toast.success(
          `Running "${skill.name}"`,
          `A cloud task is applying the skill to ${row.owner}/${row.repo}#${row.number}.`
        );
      }
      // When `created` is false, no provider was connected — runSkillTask has
      // opened the "connect an agent" modal, so just close the picker for it.
      onClose();
    } catch (err) {
      toast.error(
        `Couldn't run "${skill.name}"`,
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setLaunching(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (pendingSkill) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, navOrder.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const skill = navOrder[highlighted];
      if (skill) void launch(skill);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  const renderSkillRow = (skill: SkillSummary, navIndex: number) => {
    const meta = SOURCE_META[skill.source];
    const tooLarge = isSkillTooLarge(skill);
    const count = usage[skill.key]?.count ?? 0;
    return (
      <button
        key={`${skill.key}:${navIndex}`}
        type="button"
        disabled={tooLarge || launching}
        onClick={() => void launch(skill)}
        onMouseEnter={() => setHighlighted(navIndex)}
        className={cn(
          'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
          navIndex === highlighted && !tooLarge ? 'bg-muted' : 'hover:bg-muted/60',
          tooLarge && 'cursor-not-allowed opacity-50'
        )}
      >
        <meta.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{skill.name}</span>
            <span className="shrink-0 rounded border px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {meta.label}
            </span>
            {tooLarge && (
              <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[10px] uppercase text-amber-600 dark:text-amber-400">
                Too large to run
              </span>
            )}
            {count > 0 && (
              <span className="shrink-0 text-[10px] text-muted-foreground">×{count}</span>
            )}
          </span>
          {skill.description && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {skill.description}
            </span>
          )}
        </span>
      </button>
    );
  };

  const frequentKeys = new Set(frequent.map((s) => s.key));
  const rest = sorted.filter((s) => !frequentKeys.has(s.key));
  const grouped: { title: string; items: SkillSummary[] }[] = query.trim()
    ? [{ title: 'Results', items: rest }]
    : (
        [
          { title: `In this repo (${row.owner}/${row.repo})`, items: rest.filter((s) => s.source === 'repo') },
          { title: 'On Talyn', items: rest.filter((s) => s.source === 'platform') },
          { title: 'On this machine', items: rest.filter((s) => s.source === 'local') },
        ] as const
      ).filter((g) => g.items.length > 0);

  // navIndex bookkeeping: frequent section first, then groups in render order.
  let navIndex = 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl p-4" onClose={onClose}>
        <DialogHeader className="mb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-violet-500" />
            {pendingSkill
              ? `Run "${pendingSkill.name}" with…`
              : `Run a skill on ${row.owner}/${row.repo}#${row.number}`}
          </DialogTitle>
        </DialogHeader>

        {pendingSkill ? (
          <div className="space-y-1">
            {taskProviders?.map((p) => (
              <button
                key={p.type}
                type="button"
                disabled={launching}
                onClick={() => void launch(pendingSkill, p.type)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
              >
                {launching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                {p.displayName}
              </button>
            ))}
            <div className="my-1 border-t" />
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenIntegrations?.();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
            >
              <Settings className="h-3.5 w-3.5" />
              Set default…
            </button>
            <button
              type="button"
              onClick={() => setPendingSkill(null)}
              className="mt-1 w-full rounded-md px-2 py-1.5 text-center text-xs text-muted-foreground hover:bg-muted"
            >
              ← Back to skills
            </button>
          </div>
        ) : (
          <div onKeyDown={onKeyDown}>
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              className="mb-2 h-8"
              data-attr="skill-picker-search"
            />

            {repoStatus === 'error' && (
              <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Couldn&apos;t load this repo&apos;s skills
                </span>
                <button
                  type="button"
                  onClick={() => void refresh({ refreshRepo: true })}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-amber-500/20"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </div>
            )}

            <div className="max-h-[26rem] overflow-y-auto">
              {loading && navOrder.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading skills…
                </div>
              ) : navOrder.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {query.trim()
                    ? 'No skills match your search.'
                    : 'No skills found — add one in Settings → Skills, drop one in ~/.claude/skills, or commit one under .claude/skills in the repo.'}
                </div>
              ) : (
                <>
                  {frequent.length > 0 && (
                    <div className="mb-1">
                      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Frequently used
                      </div>
                      {frequent.map((s) => renderSkillRow(s, navIndex++))}
                    </div>
                  )}
                  {grouped.map((group) => (
                    <div key={group.title} className="mb-1">
                      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {group.title}
                      </div>
                      {group.items.map((s) => renderSkillRow(s, navIndex++))}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
