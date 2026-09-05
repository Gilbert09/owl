import { useCallback, useMemo } from 'react';
import { api, type PRRow } from '../../../lib/api';
import {
  buildMergeablePrompt,
  buildSkillPrompt,
  defaultFleetModelForAgent,
  promptTemplateFor,
  type CloudProviderType,
  type FleetAgent,
  type SkillSummary,
} from '@talyn/shared';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import { useTaskActions } from '../../../hooks/useApi';
import { refreshPullRequests } from '../../../hooks/usePullRequestSync';
import { toast } from '../../../stores/toast';
import { maybeHandleBillingLimit } from '../../../stores/billing';
import { openGithubAppFlow } from '../../../lib/githubInstall';
import { trackEvent } from '../../../lib/analytics';
import { copyRich } from '../../../lib/prClipboard';
import {
  buildCopyListPayload,
  stackAncestors,
  stackWithDescendants,
  type StackMeta,
} from './stacks';

/**
 * The row/header action handlers shared by all three GitHub pages. They mutate
 * the shared PR store (optimistic patches) and let the WS echo reconcile, so
 * the same action works no matter which page fired it.
 */
export function useGitHubActions() {
  const {
    currentWorkspaceId,
    workspaces,
    environments,
    selectTask,
    tasks,
    addTask,
    setActivePanel,
    cloudProviders,
    openSettings,
    openConnectAgent,
  } = useWorkspaceStore();
  const { createTask, stopTask: stopTaskRequest } = useTaskActions();
  const { patchRow, removeRow } = usePullRequestStore.getState();

  // Which cloud providers this workspace has connected — read from the shared
  // store (preloaded + kept fresh by useSystemStatus), so this and the Settings
  // cards agree. `connected` reflects stored credentials, not just the env
  // marker (which lingers after disconnect).
  const connectedProviders = useMemo(
    () => (cloudProviders ?? []).filter((p) => p.connected),
    [cloudProviders]
  );

  // The workspace's default-provider setting and whether starting a task should
  // prompt (a dropdown on the Task button) — only when "ask" AND there's an
  // actual choice (>1 connected).
  const workspaceSettings = workspaces.find((w) => w.id === currentWorkspaceId)?.settings;
  const defaultCloudProvider = workspaceSettings?.defaultCloudProvider;
  // The menu lists AGENTS, not providers. Talyn Fleet runs on the workspace's
  // own Claude subscription or its own Codex subscription, and "Talyn Fleet"
  // alone cannot say which — so a fleet with both connected contributes two
  // entries, and one with neither contributes none. An agent the workspace has
  // not connected is never offered: picking it would produce a task the backend
  // refuses at dispatch, which is a worse answer than not offering it.
  //
  // A fleet entry carries a MODEL, because the model is what carries the
  // vendor: `fleetProviderForModel` reads it and the fleet builds the microVM's
  // egress route table from that. Sending an agent name as well would be a
  // second source of truth that can disagree with the first.
  const taskProviders = useMemo(
    () =>
      connectedProviders.flatMap((p) => {
        if (p.type !== 'selfhosted') return [{ type: p.type, displayName: p.displayName }];
        const agents = (p.connectedAgents ?? []) as FleetAgent[];
        return agents.map((agent) => ({
          type: p.type,
          displayName: `${p.displayName} · ${agent === 'codex' ? 'Codex' : 'Claude'}`,
          model: defaultFleetModelForAgent(agent),
        }));
      }),
    [connectedProviders]
  );
  const taskAsk = defaultCloudProvider === 'ask' && taskProviders.length > 1;
  const openIntegrations = useCallback(() => openSettings('integrations'), [openSettings]);

  // Auto fallback env, in the same order the backend's resolveCloudEnvChain
  // uses — the two must agree or a task started from the UI lands somewhere the
  // backend's own auto-fix would not have sent it.
  // (Named `posthogEnvId`/`posthogEnabled` to avoid churning consumers.)
  const posthogEnvId = useMemo(() => {
    const envFor = (type: string) => environments.find((e) => e.type === type)?.id ?? null;
    for (const type of ['selfhosted', 'posthog_code']) {
      if (connectedProviders.some((p) => p.type === type)) {
        const id = envFor(type);
        if (id) return id;
      }
    }
    return null;
  }, [environments, connectedProviders]);
  // Whether a task can dispatch to the default/auto provider right now. Only the
  // ConnectAgentModal reads this — to auto-run a stashed task the instant a
  // provider connects (its env row lands) and not a tick before.
  const providerReady = posthogEnvId !== null;

  // Resolve which cloud env a new task dispatches to. An explicit `providerType`
  // (chosen from the Task-button dropdown when the default is "ask") wins.
  // Otherwise honour the workspace's `defaultCloudProvider`: a pinned provider
  // when connected, else auto (prefer PostHog, then Claude). "ask" with no
  // explicit choice — a single-provider workspace, or a non-UI caller — also
  // falls back to auto. Returns null when nothing is connected / resolvable.
  const resolveTaskEnvId = useCallback(
    (providerType?: string): string | null => {
      const envFor = (type: string) => environments.find((e) => e.type === type)?.id ?? null;
      if (providerType) {
        return connectedProviders.some((p) => p.type === providerType)
          ? envFor(providerType)
          : null;
      }
      const def = workspaces.find((w) => w.id === currentWorkspaceId)?.settings
        ?.defaultCloudProvider;
      if (def && def !== 'ask' && connectedProviders.some((p) => p.type === def)) {
        const id = envFor(def);
        if (id) return id;
      }
      return posthogEnvId;
    },
    [environments, workspaces, currentWorkspaceId, connectedProviders, posthogEnvId]
  );

  // Deep-link to a row's linked task. It may not be in the store yet (e.g. a
  // backend-created merge-queue fix run on a client that connected after it
  // started), so fetch it on demand.
  const openTask = useCallback(
    (taskId: string) => {
      setActivePanel('queue');
      selectTask(taskId);
      if (!tasks.some((t) => t.id === taskId)) {
        api.tasks
          .get(taskId)
          .then((t) => addTask(t))
          .catch(() => {});
      }
    },
    [setActivePanel, selectTask, tasks, addTask]
  );

  // Stop a row's linked task from the row itself. The store update flips the
  // badge and brings the start button back; the row toasts a failure.
  // Stop the run on a PR — and, when that PR is in the merge queue, take it OUT
  // of the queue in the same gesture.
  //
  // Order matters and is the whole fix. Stopping alone lands the task in
  // `cancelled`, which is a terminal task status, which is a trigger the queue
  // reacts to by evaluating the group again — finds no active run, and fires
  // the NEXT run at the same PR. So the Stop button read as "start another
  // one". Dequeuing FIRST means the terminal-task trigger looks the entry up by
  // fix task and finds nothing to evaluate.
  //
  // The dequeue is best-effort: failing to leave the queue must not stop us
  // stopping the run, which is the part the user actually pressed.
  const stopTask = useCallback(
    async (taskId: string, row?: PRRow) => {
      if (row?.mergeQueued) {
        patchRow(row.id, { mergeQueued: false, mergeQueue: null });
        try {
          await api.pullRequests.setMergeQueue(row.id, false);
        } catch {
          patchRow(row.id, { mergeQueued: true });
        }
      }
      await stopTaskRequest(taskId);
    },
    [stopTaskRequest, patchRow]
  );

  // Squash-merge a PR straight from its row. Throws (with GitHub's reason) if
  // rejected so the row can toast it; on success it drops the row optimistically
  // and reconciles via a re-list.
  const mergeRow = useCallback(
    async (row: PRRow) => {
      const ref = `${row.owner}/${row.repo}#${row.number}`;
      const result = await api.pullRequests.merge(row.id);
      // The base branch may be behind an external merge queue (trunk.io,
      // GitHub's native queue) — nobody but that system can merge it, so the
      // backend submits the PR to it instead. The PR stays open until the queue
      // merges it, so keep the row and just say what happened.
      if (result.submitted) {
        trackEvent('pr_submitted_external_queue', {
          repo: `${row.owner}/${row.repo}`,
          pr_number: row.number,
          via: result.via ?? 'auto_merge',
        });
        toast.success(`Submitted ${ref} to the merge queue`, result.message);
        await refreshPullRequests();
        return;
      }
      // The PR had already merged/closed on GitHub and our row was stale — the
      // backend reconciled it. Don't claim WE merged it (and don't count it as
      // a merge), just drop the row and say what was actually true.
      if (result.alreadyTerminal) {
        toast.success(`${ref} was already ${result.merged ? 'merged' : 'closed'}`, result.message);
        removeRow(row.id);
        await refreshPullRequests();
        return;
      }
      // GitHub can 200 with `merged: false` — treat that as failure so we
      // don't claim success and wrongly drop the row.
      if (!result.merged) {
        throw new Error(result.message || 'GitHub did not merge the pull request');
      }
      trackEvent('pr_merged', {
        source: 'manual',
        repo: `${row.owner}/${row.repo}`,
        pr_number: row.number,
        blocking_reason: row.summary.blockingReason,
      });
      toast.success(`Merged ${ref}`, row.summary.title);
      removeRow(row.id);
      await refreshPullRequests();
    },
    [removeRow]
  );

  // Add/remove a PR from the Talyn merge queue. Optimistically patches the
  // row so the badge flips instantly; the backend echoes the authoritative
  // state (incl. queue position) over WS. Rolls back on error.
  const setMergeQueue = useCallback(
    async (row: PRRow, enabled: boolean) => {
      // Flip the membership flag only. Never fabricate a `mergeQueue` payload:
      // the table renders it whenever present, so an invented status/position
      // would show and stick until the echo lands. Without one the badge reads
      // "Queued" with no number for the moment before the server answers,
      // which is true.
      patchRow(row.id, { mergeQueued: enabled, ...(enabled ? {} : { mergeQueue: null }) });
      try {
        await api.pullRequests.setMergeQueue(row.id, enabled);
        trackEvent('merge_queue_toggled', {
          enabled,
          repo: `${row.owner}/${row.repo}`,
          pr_number: row.number,
        });
      } catch (err) {
        patchRow(row.id, { mergeQueued: !enabled });
        // Free-plan queue cap → upgrade modal instead of a raw error toast.
        if (maybeHandleBillingLimit(err, 'merge_queue')) return;
        toast.error(
          `Couldn't ${enabled ? 'queue' : 'dequeue'} ${row.owner}/${row.repo}#${row.number}`,
          err instanceof Error ? err.message : undefined
        );
      }
    },
    [patchRow]
  );

  /**
   * Start or stop tracking a PR.
   *
   * Optimistic. Enabling on Reviews is the point of the button there: once you
   * submit a review the monitor clears `reviewRequested` and the PR leaves that
   * list, so watching is what keeps it on My PRs. Disabling NEVER cancels a
   * queue entry or an armed watcher — the PR just stops appearing on your list.
   */
  const setWatching = useCallback(
    async (row: PRRow, enabled: boolean) => {
      patchRow(row.id, { watching: enabled });
      try {
        await api.pullRequests.setWatching(row.id, enabled);
      } catch (err) {
        patchRow(row.id, { watching: !enabled });
        toast.error(
          `Couldn't ${enabled ? 'track' : 'stop tracking'} ${row.owner}/${row.repo}#${row.number}`,
          err instanceof Error ? err.message : undefined
        );
      }
    },
    [patchRow]
  );

  /**
   * Queue or dequeue a whole stack of dependent PRs in one call.
   *
   * The server resolves the chain — the client's own derivation only decides
   * which rows to patch optimistically, and the WS echo corrects it either way.
   *
   * Enabling takes everything `row` is based on, plus everything stacked on it
   * when `includeDescendants` (what the button on a stack ROOT means, where
   * "the whole stack" is unambiguous). On DEQUEUE it always takes every PR
   * stacked above `row`, because each is parked on it and would otherwise wait
   * forever.
   */
  const setMergeQueueStack = useCallback(
    async (row: PRRow, enabled: boolean, opts?: { includeDescendants?: boolean }) => {
      const rows = usePullRequestStore.getState().rows;
      const affected = !enabled
        ? stackWithDescendants(rows, row.id)
        : opts?.includeDescendants
          ? [...stackAncestors(rows, row.id), ...stackWithDescendants(rows, row.id).slice(1)]
          : stackAncestors(rows, row.id);
      // Snapshot exactly what we are about to overwrite, so a failure restores
      // every row rather than leaving half the stack looking queued.
      const before = affected.map((r) => ({
        id: r.id,
        mergeQueued: r.mergeQueued,
        mergeQueue: r.mergeQueue ?? null,
      }));
      for (const r of affected) {
        // Membership only — see the single-PR toggle above for why no payload
        // is invented here.
        patchRow(r.id, { mergeQueued: enabled, ...(enabled ? {} : { mergeQueue: null }) });
      }
      try {
        const result = await api.pullRequests.setMergeQueueStack(row.id, enabled, {
          includeDescendants: opts?.includeDescendants,
        });
        trackEvent('merge_stack_toggled', {
          enabled,
          size: result.pullRequestIds.length,
          repo: `${row.owner}/${row.repo}`,
          pr_number: row.number,
        });
        // The server is the authority on membership; say so when it disagreed.
        if (result.skipped.length > 0) {
          toast.info(
            `Queued ${result.pullRequestIds.length} of ${result.pullRequestIds.length + result.skipped.length}`,
            result.skipped.map((s) => s.reason).join(', ')
          );
        }
      } catch (err) {
        for (const snap of before) {
          patchRow(snap.id, {
            mergeQueued: snap.mergeQueued,
            mergeQueue: snap.mergeQueue,
          });
        }
        // Free-plan queue cap → upgrade modal instead of a raw error toast. A
        // separate trigger so the funnel can tell stack upgrades from single-PR.
        if (maybeHandleBillingLimit(err, 'merge_stack')) return;
        toast.error(
          `Couldn't ${enabled ? 'queue' : 'dequeue'} the stack for ${row.owner}/${row.repo}#${row.number}`,
          err instanceof Error ? err.message : undefined
        );
      }
    },
    [patchRow]
  );

  // Kick off a cloud run to take the PR to a clean, mergeable state. The
  // provider is resolved from the workspace's default (which may prompt the
  // picker when set to "ask"); the run happens entirely in the cloud, so we stay
  // on the current page — the row's task badge is the user's signal it started.
  const createPostHogTask = useCallback(
    async (row: PRRow, providerType?: string, model?: string): Promise<boolean> => {
      if (!currentWorkspaceId) return false;
      const envId = resolveTaskEnvId(providerType);
      if (!envId) {
        // No provider connected/resolvable. Prompt the user to connect one and
        // stash this fix so it auto-runs the moment they do.
        openConnectAgent({ kind: 'fix', row, providerType, model });
        return false;
      }
      // Build the prompt for the provider actually behind the resolved env — the
      // git/publishing mechanics differ (PostHog signed-git vs Claude's GitHub MCP).
      const provider = (environments.find((e) => e.id === envId)?.type ??
        'posthog_code') as CloudProviderType;
      const ref = `${row.owner}/${row.repo}#${row.number}`;
      const created = await createTask({
        workspaceId: currentWorkspaceId,
        type: 'pr_response',
        title: `Get ${ref} mergeable`,
        description: `Take ${ref} ("${row.summary.title}") to a clean, mergeable state.`,
        prompt: buildMergeablePrompt({
          owner: row.owner,
          repo: row.repo,
          number: row.number,
          summary: row.summary,
          provider,
          template: promptTemplateFor(workspaceSettings, 'mergeable'),
        }),
        repositoryId: row.repositoryId,
        assignedEnvironmentId: envId,
        pullRequestId: row.id,
        // Only set when the user picked an agent from the menu. Absent lets the
        // backend resolve the workspace's own model, then the default for
        // whichever credential it actually holds.
        ...(model ? { model } : {}),
      });
      trackEvent('pr_fix_task_started', {
        repo: `${row.owner}/${row.repo}`,
        pr_number: row.number,
        blocking_reason: row.summary.blockingReason,
      });
      // Optimistically link the row so the in-progress indicator shows instantly.
      patchRow(row.id, { taskId: created.id });
      return true;
    },
    [currentWorkspaceId, workspaceSettings, resolveTaskEnvId, environments, createTask, patchRow, openConnectAgent]
  );

  // Run an agent skill against a PR as a cloud task. Resolves the skill's
  // content by source (platform / repo via the API; local content is read on
  // this machine and passed in), inlines it into a provider-aware prompt, and
  // creates a normal cloud task linked to the PR. Returns false when no
  // provider env resolves; throws on fetch/create failure (caller toasts).
  const runSkillTask = useCallback(
    async (
      row: PRRow,
      skill: SkillSummary,
      opts: { providerType?: string; model?: string; localContent?: string } = {}
    ): Promise<boolean> => {
      if (!currentWorkspaceId) return false;
      const envId = resolveTaskEnvId(opts.providerType);
      if (!envId) {
        openConnectAgent({
          kind: 'skill',
          row,
          skill,
          localContent: opts.localContent,
          providerType: opts.providerType,
          model: opts.model,
        });
        return false;
      }
      const provider = (environments.find((e) => e.id === envId)?.type ??
        'posthog_code') as CloudProviderType;
      const ref = `${row.owner}/${row.repo}#${row.number}`;

      let content: string;
      let repoPath: string | undefined;
      if (skill.source === 'local') {
        if (!opts.localContent) throw new Error(`Local skill "${skill.name}" has no content`);
        content = opts.localContent;
      } else if (skill.source === 'platform') {
        if (!skill.id) throw new Error(`Platform skill "${skill.name}" has no id`);
        content = (await api.skills.get(skill.id)).content;
      } else {
        if (!skill.repositoryId) throw new Error(`Repo skill "${skill.name}" has no repository`);
        const fetched = await api.skills.repoContent(
          currentWorkspaceId,
          skill.repositoryId,
          skill.name
        );
        content = fetched.content;
        repoPath = fetched.repoPath;
      }

      const created = await createTask({
        workspaceId: currentWorkspaceId,
        type: 'pr_response',
        title: `Run skill "${skill.name}" on ${ref}`,
        description: `Run the "${skill.name}" skill against ${ref} ("${row.summary.title}").`,
        prompt: buildSkillPrompt({
          owner: row.owner,
          repo: row.repo,
          number: row.number,
          pr: {
            url: row.summary.url,
            title: row.summary.title,
            headBranch: row.summary.headBranch,
            baseBranch: row.summary.baseBranch,
          },
          skill: {
            name: skill.name,
            description: skill.description,
            content,
            source: skill.source,
            repoPath,
          },
          provider,
          template: promptTemplateFor(workspaceSettings, 'skill'),
        }),
        repositoryId: row.repositoryId,
        assignedEnvironmentId: envId,
        pullRequestId: row.id,
        skill: {
          key: skill.key,
          name: skill.name,
          source: skill.source,
          repositoryId: skill.repositoryId,
          platformSkillId: skill.id,
        },
        ...(opts.model ? { model: opts.model } : {}),
      });
      trackEvent('pr_skill_task_started', {
        repo: `${row.owner}/${row.repo}`,
        pr_number: row.number,
        skill_source: skill.source,
      });
      patchRow(row.id, { taskId: created.id });
      return true;
    },
    [currentWorkspaceId, workspaceSettings, resolveTaskEnvId, environments, createTask, patchRow, openConnectAgent]
  );

  // Connect GitHub for the workspace via the GitHub App install flow.
  const connect = useCallback(async () => {
    if (!currentWorkspaceId) return;
    trackEvent('github_connect_started');
    // Shared helper: opens a separate tab (claimed synchronously, before the
    // fetch spends user activation) so this page survives — see
    // lib/githubInstall.
    await openGithubAppFlow(currentWorkspaceId, 'connect');
  }, [currentWorkspaceId]);

  // Copy the given PRs as a list for pasting into Slack (etc.). Writes a rich
  // `text/html` bullet list of hyperlinks plus a plain-text markdown fallback;
  // stacked PRs are indented under their parent when stack meta is provided.
  const copyList = useCallback(async (rows: PRRow[], stackMeta?: Map<string, StackMeta>) => {
    const payload = buildCopyListPayload(rows, stackMeta);
    if (!payload) {
      toast.info('Nothing to copy', 'No pull requests match the current filters.');
      return;
    }
    const { markdown, html } = payload;
    const count = `${payload.count} PR${payload.count === 1 ? '' : 's'}`;
    try {
      await copyRich(html, markdown);
      toast.success(`Copied ${count}`, 'Paste into Slack to request approval.');
    } catch {
      try {
        await navigator.clipboard.writeText(markdown);
        toast.success(`Copied ${count}`, 'Paste into Slack to request approval.');
      } catch {
        toast.error('Could not copy to clipboard');
      }
    }
  }, []);

  return {
    providerReady,
    openTask,
    stopTask,
    mergeRow,
    setMergeQueue,
    setMergeQueueStack,
    setWatching,
    createPostHogTask,
    runSkillTask,
    connect,
    copyList,
    // Per-task provider selection (drives the Task-button dropdown when the
    // workspace default is "Ask every time").
    taskAsk,
    taskProviders,
    openIntegrations,
  };
}
