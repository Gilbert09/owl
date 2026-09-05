import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, FileText, Loader2, Pencil, RotateCcw, Sparkles } from 'lucide-react';
import {
  DEFAULT_PROMPT_TEMPLATES,
  PROMPT_KINDS,
  PROMPT_KIND_INFO,
  buildMergeablePrompt,
  buildSkillPrompt,
  defaultPromptTemplateHash,
  promptDefaultChangedSince,
  promptTemplateOverride,
  promptTemplateVariables,
  promptVariablesFor,
  validatePromptTemplate,
  type CloudProviderType,
  type PRMergeableSummary,
  type PromptKind,
  type PromptTemplateOverride,
  type PromptVariableGroup,
  type PromptVariableSpec,
  type Workspace,
} from '@talyn/shared';
import { api, type PRRow } from '../../lib/api';
import { insertVariableAt } from '../../lib/promptEditor';
import { trackEvent } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { usePullRequestStore } from '../../stores/pullRequests';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

const SELECT_CLASS =
  'h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';

const GROUP_LABEL: Record<PromptVariableGroup, string> = {
  pr: 'Pull request',
  skill: 'Skill',
  talyn: 'Talyn blocks',
};

// Every provider whose PUBLISHING DIALECT differs, so the preview shows what a
// run on that provider would actually be told. Codex Cloud is deferred and
// renders the PostHog dialect, so listing it would add an identical option.
const PREVIEW_PROVIDERS: { value: CloudProviderType; label: string }[] = [
  { value: 'selfhosted', label: 'Talyn Fleet' },
  { value: 'posthog_code', label: 'PostHog Code' },
];

const SAMPLE_PR = {
  owner: 'acme',
  repo: 'widgets',
  number: 128,
  summary: {
    url: 'https://github.com/acme/widgets/pull/128',
    title: 'Add retry to the webhook client',
    headBranch: 'feat/webhook-retry',
    baseBranch: 'main',
    mergeable: 'CONFLICTING',
    reviewDecision: 'CHANGES_REQUESTED',
    blockingReason: 'merge_conflicts',
    checks: { total: 6, failed: 1 },
    unresolvedReviewThreads: 3,
  } as PRMergeableSummary,
};

const SAMPLE_SKILL = {
  name: 'pr-review',
  description: 'Review the PR for correctness and style.',
  content:
    '---\nname: pr-review\ndescription: Review the PR for correctness and style.\n---\n\nRead the diff, check the tests, and leave one review with findings ordered by severity.',
  source: 'platform' as const,
};

export function InstructionsSettings() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const [editing, setEditing] = useState<PromptKind | null>(null);
  const [resetting, setResetting] = useState<PromptKind | null>(null);

  const applyWorkspace = (updated: Workspace) => {
    setWorkspaces(workspaces.map((w) => (w.id === updated.id ? updated : w)));
  };

  async function savePrompt(kind: PromptKind, override: PromptTemplateOverride | null) {
    if (!currentWorkspaceId) return;
    const updated = await api.workspaces.update(currentWorkspaceId, {
      settings: { prompts: { [kind]: override } },
    });
    applyWorkspace(updated);
    trackEvent(override ? 'prompt_template_saved' : 'prompt_template_reset', {
      kind,
      ...(override ? { chars: override.template.length } : {}),
    });
    const label = PROMPT_KIND_INFO[kind].label;
    toast.success(override ? `${label} prompt saved` : `${label} prompt reset to Talyn's default`);
  }

  async function resetFromCard(kind: PromptKind) {
    setResetting(kind);
    try {
      await savePrompt(kind, null);
    } catch (err) {
      toast.error('Could not reset the prompt', err instanceof Error ? err.message : undefined);
    } finally {
      setResetting(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Instructions</h3>
        <p className="text-sm text-muted-foreground mt-1">
          The prompts Talyn hands to a cloud agent. Each starts from Talyn&apos;s default; customize
          one to replace it for this workspace. Anything in double braces, like{' '}
          <code className="text-xs">{'{{pr.url}}'}</code>, is filled in per run.
        </p>
      </div>

      {PROMPT_KINDS.map((kind) => {
        const info = PROMPT_KIND_INFO[kind];
        const override = promptTemplateOverride(workspace?.settings, kind);
        const stale = override ? promptDefaultChangedSince(override, kind) : false;
        return (
          <Card key={kind} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium flex items-center gap-2">
                    {kind === 'skill' ? (
                      <Sparkles className="w-4 h-4 text-violet-500" />
                    ) : (
                      <FileText className="w-4 h-4 text-muted-foreground" />
                    )}
                    {info.label}
                  </h4>
                  {override ? (
                    <Badge variant="success">Customized</Badge>
                  ) : (
                    <Badge variant="outline">Default</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{info.usedFor}</p>
                {override && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last edited {new Date(override.updatedAt).toLocaleString()}
                  </p>
                )}
                {stale && (
                  <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-2 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Talyn&apos;s default for this prompt changed since you customized it.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {override && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1"
                    disabled={resetting === kind || !currentWorkspaceId}
                    onClick={() => void resetFromCard(kind)}
                  >
                    {resetting === kind ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="w-3.5 h-3.5" />
                    )}
                    Reset
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  disabled={!currentWorkspaceId}
                  onClick={() => setEditing(kind)}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  {override ? 'Edit' : 'Customize'}
                </Button>
              </div>
            </div>
          </Card>
        );
      })}

      {editing && (
        <PromptTemplateEditor
          kind={editing}
          override={promptTemplateOverride(workspace?.settings, editing)}
          onClose={() => setEditing(null)}
          onSave={async (override) => {
            await savePrompt(editing, override);
            setEditing(null);
          }}
          onReset={async () => {
            await savePrompt(editing, null);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

type EditorTab = 'edit' | 'preview' | 'default';

function PromptTemplateEditor({
  kind,
  override,
  onClose,
  onSave,
  onReset,
}: {
  kind: PromptKind;
  override: PromptTemplateOverride | undefined;
  onClose: () => void;
  onSave: (override: PromptTemplateOverride) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const info = PROMPT_KIND_INFO[kind];
  const defaultTemplate = DEFAULT_PROMPT_TEMPLATES[kind];
  const currentDefaultHash = defaultPromptTemplateHash(kind);
  const [template, setTemplate] = useState(override?.template ?? defaultTemplate);
  const [basedOnHash, setBasedOnHash] = useState(override?.basedOnHash ?? currentDefaultHash);
  const [tab, setTab] = useState<EditorTab>('edit');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const variables = useMemo(() => promptVariablesFor(kind), [kind]);
  const used = useMemo(() => new Set(promptTemplateVariables(template)), [template]);
  const validation = useMemo(() => validatePromptTemplate(kind, template), [kind, template]);
  const dirty = template !== (override?.template ?? defaultTemplate) || basedOnHash !== (override?.basedOnHash ?? currentDefaultHash);
  const isDefaultText = template === defaultTemplate;
  const staleDefault = override ? basedOnHash !== currentDefaultHash : false;

  useEffect(() => {
    if (pendingCaret.current === null) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(caret, caret);
  }, [template]);

  function insertVariable(spec: PromptVariableSpec) {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? template.length;
    const end = ta?.selectionEnd ?? template.length;
    const result = insertVariableAt(template, start, end, spec);
    pendingCaret.current = result.caret;
    setTab('edit');
    setTemplate(result.text);
  }

  function copyDefaultIntoEditor() {
    setTemplate(defaultTemplate);
    setBasedOnHash(currentDefaultHash);
    setTab('edit');
  }

  async function handleSave() {
    if (!validation.ok) return;
    setSaving(true);
    try {
      await onSave({ template, basedOnHash, updatedAt: new Date().toISOString() });
    } catch (err) {
      toast.error('Could not save the prompt', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setResetting(true);
    try {
      await onReset();
    } catch (err) {
      toast.error('Could not reset the prompt', err instanceof Error ? err.message : undefined);
    } finally {
      setResetting(false);
    }
  }

  const grouped = useMemo(() => {
    const groups: { group: PromptVariableGroup; items: PromptVariableSpec[] }[] = [];
    for (const group of ['pr', 'skill', 'talyn'] as PromptVariableGroup[]) {
      const items = variables.filter((v) => v.group === group);
      if (items.length > 0) groups.push({ group, items });
    }
    return groups;
  }, [variables]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle>{info.label} prompt</DialogTitle>
          <DialogDescription>
            Replaces Talyn&apos;s default for this workspace. {info.usedFor}
          </DialogDescription>
        </DialogHeader>

        {staleDefault && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-yellow-600 dark:text-yellow-500" />
            <div className="flex-1">
              Talyn&apos;s default for this prompt changed since you customized it. Your version
              keeps working as written; check the Default tab if you want to pull anything in.
            </div>
            <button
              type="button"
              className="underline text-muted-foreground hover:text-foreground"
              onClick={() => setBasedOnHash(currentDefaultHash)}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-1 mb-2">
              {(
                [
                  ['edit', 'Edit'],
                  ['preview', 'Preview'],
                  ['default', 'Default'],
                ] as [EditorTab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium',
                    tab === id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {template.length.toLocaleString()} chars
              </span>
            </div>

            {tab === 'edit' && (
              <>
                <textarea
                  ref={textareaRef}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  spellCheck={false}
                  className="w-full h-[56vh] rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {validation.errors.length > 0 ? (
                  <ul className="mt-2 space-y-0.5">
                    {validation.errors.map((e) => (
                      <li key={e} className="text-xs text-red-500">
                        {e}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
                    <Check className="w-3.5 h-3.5 text-green-500" />
                    Ready to save.
                  </p>
                )}
              </>
            )}

            {tab === 'preview' && <TemplatePreview kind={kind} template={template} />}

            {tab === 'default' && (
              <>
                <pre className="w-full h-[56vh] overflow-auto rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                  {defaultTemplate}
                </pre>
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Talyn&apos;s current default. Copy it into the editor to start over from it.
                  </p>
                  <Button size="sm" variant="outline" onClick={copyDefaultIntoEditor} disabled={isDefaultText}>
                    Copy into editor
                  </Button>
                </div>
              </>
            )}
          </div>

          <div className="min-w-0 border-l pl-4">
            <div className="text-xs font-medium mb-1">Variables</div>
            <p className="text-[11px] text-muted-foreground mb-3">
              Click one to insert it at the cursor. Blocks go on their own line.
            </p>
            <div className="space-y-3 max-h-[56vh] overflow-auto pr-1">
              {grouped.map(({ group, items }) => (
                <div key={group}>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                    {GROUP_LABEL[group]}
                  </div>
                  <div className="space-y-1">
                    {items.map((v) => {
                      const inUse = used.has(v.name);
                      const missing = v.required && !inUse;
                      return (
                        <button
                          key={v.name}
                          type="button"
                          onClick={() => insertVariable(v)}
                          title={`Insert {{${v.name}}}`}
                          className={cn(
                            'w-full text-left rounded-md border px-2 py-1.5 hover:bg-muted/60 transition-colors',
                            missing ? 'border-red-500/50' : 'border-transparent'
                          )}
                        >
                          <div className="flex items-center gap-1.5">
                            <code className="text-[11px] font-mono truncate">{`{{${v.name}}}`}</code>
                            {v.shape === 'block' && (
                              <span className="text-[9px] uppercase text-muted-foreground">block</span>
                            )}
                            {v.required && (
                              <span
                                className={cn(
                                  'text-[9px] uppercase',
                                  missing ? 'text-red-500' : 'text-muted-foreground'
                                )}
                              >
                                required
                              </span>
                            )}
                            {inUse && <Check aria-label="In use" className="w-3 h-3 ml-auto text-green-500 shrink-0" />}
                          </div>
                          <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                            {v.description}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center gap-2">
            {override && (
              <Button variant="ghost" size="sm" className="gap-1" onClick={() => void handleReset()} disabled={resetting || saving}>
                {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                Reset to default
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !validation.ok || !dirty}>
              {saving && <Loader2 className="mr-1.5 w-3.5 h-3.5 animate-spin" />}
              {override ? 'Save changes' : 'Save as workspace prompt'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplatePreview({ kind, template }: { kind: PromptKind; template: string }) {
  const rows = usePullRequestStore((s) => s.rows);
  const [provider, setProvider] = useState<CloudProviderType>('posthog_code');
  const [prId, setPrId] = useState<string>('');
  const row: PRRow | undefined = rows.find((r) => r.id === prId) ?? rows[0];

  const rendered = useMemo(() => {
    const { owner, repo, number, summary } = row ?? SAMPLE_PR;
    if (kind === 'mergeable') {
      return buildMergeablePrompt({ owner, repo, number, summary, provider, template });
    }
    return buildSkillPrompt({
      owner,
      repo,
      number,
      pr: {
        url: summary.url,
        title: summary.title ?? '',
        headBranch: summary.headBranch,
        baseBranch: summary.baseBranch,
      },
      skill: SAMPLE_SKILL,
      provider,
      template,
    });
  }, [kind, template, provider, row]);

  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <select
          aria-label="Preview PR"
          value={row?.id ?? ''}
          onChange={(e) => setPrId(e.target.value)}
          className={cn(SELECT_CLASS, 'flex-1 min-w-0')}
          disabled={rows.length === 0}
        >
          {rows.length === 0 ? (
            <option value="">Sample PR (no tracked PRs yet)</option>
          ) : (
            rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.repo}#{r.number} · {r.summary.title}
              </option>
            ))
          )}
        </select>
        <select
          aria-label="Preview provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as CloudProviderType)}
          className={cn(SELECT_CLASS, 'w-40')}
        >
          {PREVIEW_PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <pre className="w-full h-[52vh] overflow-auto rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {rendered}
      </pre>
      <p className="mt-2 text-xs text-muted-foreground">
        {kind === 'skill'
          ? 'Rendered with a sample skill so you can see where the SKILL.md lands.'
          : 'Rendered against the selected PR as it looks right now.'}
      </p>
    </>
  );
}
