// Saved PR filters — the user's own named views over the PR list.
//
// The definitions live on the workspace (`settings.prFilters`), so they follow
// the user between clients; which ones are SELECTED is per-page local state,
// because a filter chip is a view you flip on for a moment, not a preference.
//
// Selected filters OR together (see `prMatchesAnyFilter`): picking "Frontend"
// and "Backend" shows both, rather than the empty intersection an AND would
// give. Within one filter, every criterion ANDs.

import React, { useEffect, useMemo, useState } from 'react';
import { Filter, Pencil, Plus, Trash2 } from 'lucide-react';
import type { PRFilterCriteria, PRFilterDefinition, Workspace } from '@talyn/shared';
import {
  MAX_PR_FILTER_NAME_LENGTH,
  prFilterIsEmpty,
  prMatchesFilter,
} from '@talyn/shared';
import type { PRRow } from '../../../lib/api';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { toast } from '../../../stores/toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Button } from '../../ui/button';
import { cn } from '../../../lib/utils';

/**
 * Read + persist the workspace's saved filters. Writes send the whole list
 * (the backend replaces the array wholesale), then patch the store in place so
 * the chips update without waiting for a workspace refetch.
 */
export function useSavedPRFilters() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const filters = useMemo(() => workspace?.settings?.prFilters ?? [], [workspace]);

  const persist = async (next: PRFilterDefinition[]) => {
    if (!currentWorkspaceId) {
      // The PR pages only render with a workspace loaded, so this is a guard
      // rather than a path — but it must not fail silently if it is ever hit.
      toast.error('Pick a workspace first');
      return false;
    }
    setSaving(true);
    try {
      const settings = { prFilters: next } as Workspace['settings'];
      const updated = await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? {
                ...w,
                settings: {
                  ...w.settings,
                  // Prefer the server's normalised copy when it echoes one —
                  // it trims and de-dupes, and the chips should show what is
                  // actually stored.
                  prFilters: updated?.settings?.prFilters ?? next,
                } as Workspace['settings'],
              }
            : w
        )
      );
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save filter');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const upsert = async (def: PRFilterDefinition) => {
    const exists = filters.some((f) => f.id === def.id);
    const next = exists ? filters.map((f) => (f.id === def.id ? def : f)) : [...filters, def];
    return persist(next);
  };

  const remove = async (id: string) => persist(filters.filter((f) => f.id !== id));

  return { filters, upsert, remove, saving };
}

/**
 * The saved-filter row: one toggle chip per filter (same look as the "Needs
 * review" toggles above it) plus the "New filter" button. Rendered on its own
 * line under the repo/search row.
 */
export function SavedFilterBar({
  filters,
  activeIds,
  onToggle,
  onNew,
  onEdit,
  rows,
}: {
  filters: PRFilterDefinition[];
  activeIds: string[];
  onToggle: (id: string) => void;
  onNew: () => void;
  onEdit: (f: PRFilterDefinition) => void;
  /** The page's rows before saved filters are applied — drives the per-chip count. */
  rows: PRRow[];
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of filters) {
      m.set(f.id, rows.filter((r) => prMatchesFilter(r, f.criteria)).length);
    }
    return m;
  }, [filters, rows]);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span
        className="flex items-center gap-1 text-muted-foreground"
        title={
          filters.length > 1
            ? 'Your saved filters. Selecting more than one shows the PRs matching any of them.'
            : 'Your saved filters — workspace-scoped, so they follow you between clients.'
        }
      >
        <Filter className="h-3 w-3" />
        Filters
      </span>
      {filters.map((f) => {
        const active = activeIds.includes(f.id);
        const count = counts.get(f.id) ?? 0;
        return (
          <span
            key={f.id}
            className={cn(
              'group inline-flex items-center overflow-hidden rounded-md border transition-colors',
              active
                ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <button
              type="button"
              onClick={() => onToggle(f.id)}
              className="max-w-[220px] truncate px-2 py-1"
              title={`${describeCriteria(f.criteria)} — ${count} matching PR${count === 1 ? '' : 's'} on this page`}
            >
              {f.name}
              <span className="ml-1 opacity-70">{count}</span>
            </button>
            <button
              type="button"
              onClick={() => onEdit(f)}
              className="px-1.5 py-1 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-70"
              title={`Edit "${f.name}"`}
            >
              <Pencil className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        onClick={onNew}
        className="flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
        title="Create a saved filter for this workspace"
      >
        <Plus className="h-3 w-3" />
        New filter
      </button>
    </div>
  );
}

/** One-line English for what a filter tests — the chip's hover tooltip. */
export function describeCriteria(c: PRFilterCriteria): string {
  const parts: string[] = [];
  if (c.repos?.length) parts.push(`repo: ${c.repos.join(', ')}`);
  if (c.labels?.length) {
    parts.push(`${c.labelMatch === 'all' ? 'all labels' : 'any label'}: ${c.labels.join(', ')}`);
  }
  if (c.excludeLabels?.length) parts.push(`without: ${c.excludeLabels.join(', ')}`);
  if (c.titleContains) parts.push(`title contains "${c.titleContains}"`);
  if (c.authors?.length) parts.push(`author: ${c.authors.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : 'no criteria';
}

/** Comma-separated text ⇄ the string lists the criteria store. */
function parseList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

interface PRFilterModalProps {
  open: boolean;
  /** The filter being edited, or null when creating a new one. */
  editing: PRFilterDefinition | null;
  onClose: () => void;
  onSave: (def: PRFilterDefinition) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  saving: boolean;
  /** The page's rows — the label/author suggestions and the live match count. */
  rows: PRRow[];
}

/**
 * Create/edit dialog for one saved filter: its name plus the criteria (repos,
 * labels, title, author). Shows how many of the page's PRs the draft matches
 * as you type, so a filter can't be saved blind.
 */
export function PRFilterModal({
  open,
  editing,
  onClose,
  onSave,
  onDelete,
  saving,
  rows,
}: PRFilterModalProps) {
  const repositories = useWorkspaceStore((s) => s.repositories);

  const [name, setName] = useState('');
  const [repos, setRepos] = useState<string[]>([]);
  const [labels, setLabels] = useState('');
  const [labelMatch, setLabelMatch] = useState<'any' | 'all'>('any');
  const [excludeLabels, setExcludeLabels] = useState('');
  const [titleContains, setTitleContains] = useState('');
  const [authors, setAuthors] = useState('');

  // Reload the form whenever the dialog opens (or switches which filter it is
  // editing) — the component stays mounted between openings.
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setRepos(editing?.criteria.repos ?? []);
    setLabels((editing?.criteria.labels ?? []).join(', '));
    setLabelMatch(editing?.criteria.labelMatch === 'all' ? 'all' : 'any');
    setExcludeLabels((editing?.criteria.excludeLabels ?? []).join(', '));
    setTitleContains(editing?.criteria.titleContains ?? '');
    setAuthors((editing?.criteria.authors ?? []).join(', '));
  }, [open, editing]);

  // Suggestions come from what's actually on this page's PRs — the workspace
  // has no label index of its own, and the union of the loaded rows is both
  // free and exactly the vocabulary the user is looking at.
  const knownLabels = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const l of r.summary.labels ?? []) s.add(l);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [rows]);
  const knownAuthors = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.summary.author) s.add(r.summary.author);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const criteria = useMemo<PRFilterCriteria>(() => {
    const c: PRFilterCriteria = {};
    if (repos.length > 0) c.repos = repos;
    const wanted = parseList(labels);
    if (wanted.length > 0) {
      c.labels = wanted;
      if (labelMatch === 'all') c.labelMatch = 'all';
    }
    const excluded = parseList(excludeLabels);
    if (excluded.length > 0) c.excludeLabels = excluded;
    if (titleContains.trim()) c.titleContains = titleContains.trim();
    const who = parseList(authors);
    if (who.length > 0) c.authors = who;
    return c;
  }, [repos, labels, labelMatch, excludeLabels, titleContains, authors]);

  const matchCount = useMemo(
    () => (prFilterIsEmpty(criteria) ? rows.length : rows.filter((r) => prMatchesFilter(r, criteria)).length),
    [criteria, rows]
  );

  const empty = prFilterIsEmpty(criteria);
  const named = name.trim().length > 0;
  const canSave = named && !empty && !saving;

  const submit = async () => {
    if (!canSave) return;
    const now = new Date().toISOString();
    const def: PRFilterDefinition = {
      id: editing?.id ?? crypto.randomUUID(),
      name: name.trim(),
      criteria,
      createdAt: editing?.createdAt ?? now,
      updatedAt: now,
    };
    if (await onSave(def)) onClose();
  };

  const del = async () => {
    if (!editing) return;
    if (await onDelete(editing.id)) onClose();
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit filter' : 'New filter'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name" hint="Shown on the chip in the PR filter bar.">
            <Input
              autoFocus
              value={name}
              maxLength={MAX_PR_FILTER_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="e.g. Frontend, needs my review"
            />
          </Field>

          <Field
            label="Repositories"
            hint={
              repos.length === 0
                ? 'Nothing selected = any repo in this workspace.'
                : `${repos.length} selected.`
            }
          >
            <div className="max-h-36 space-y-1 overflow-auto rounded-md border p-2">
              {repositories.length === 0 && (
                <p className="text-xs text-muted-foreground">No repositories are watched yet.</p>
              )}
              {repositories.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={repos.includes(r.fullName)}
                    onChange={(e) =>
                      setRepos((prev) =>
                        e.target.checked
                          ? [...prev, r.fullName]
                          : prev.filter((x) => x !== r.fullName)
                      )
                    }
                  />
                  {r.fullName}
                </label>
              ))}
            </div>
          </Field>

          <Field
            label="Labels"
            hint="Comma-separated. Case-insensitive."
            right={
              <select
                value={labelMatch}
                onChange={(e) => setLabelMatch(e.target.value === 'all' ? 'all' : 'any')}
                className="h-7 rounded-md border bg-background px-2 py-0 text-xs leading-7"
                title="Whether a PR needs any one of these labels, or all of them"
              >
                <option value="any">Match any</option>
                <option value="all">Match all</option>
              </select>
            }
          >
            <Input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="bug, frontend"
              list="talyn-pr-filter-labels"
            />
          </Field>

          <Field label="Exclude labels" hint="A PR carrying any of these never matches.">
            <Input
              value={excludeLabels}
              onChange={(e) => setExcludeLabels(e.target.value)}
              placeholder="wip, do-not-merge"
              list="talyn-pr-filter-labels"
            />
          </Field>

          <Field label="Title contains" hint="Case-insensitive substring of the PR title.">
            <Input
              value={titleContains}
              onChange={(e) => setTitleContains(e.target.value)}
              placeholder="feat("
            />
          </Field>

          <Field label="Authors" hint="Comma-separated GitHub logins.">
            <Input
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
              placeholder="octocat"
              list="talyn-pr-filter-authors"
            />
          </Field>

          <datalist id="talyn-pr-filter-labels">
            {knownLabels.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
          <datalist id="talyn-pr-filter-authors">
            {knownAuthors.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>

          <p className="text-xs text-muted-foreground">
            {empty
              ? 'Set at least one criterion — a filter with none would match every PR.'
              : `Matches ${matchCount} of ${rows.length} PR${rows.length === 1 ? '' : 's'} on this page.`}
          </p>
        </div>

        <div className="mt-6 flex items-center justify-between gap-2">
          <div>
            {editing && (
              <Button variant="ghost" size="sm" onClick={() => void del()} disabled={saving}>
                <Trash2 className="mr-1 h-4 w-4" />
                Delete
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={!canSave}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Create filter'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  right,
  children,
}: {
  label: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium">{label}</label>
        {right}
      </div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
