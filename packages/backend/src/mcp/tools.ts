import type { CreateTaskRequest, Task, TaskType, Workspace } from '@talyn/shared';
import { callApi, type PrSummary, type PublicPr } from './api.js';

/**
 * A single MCP tool. `handler` runs as `ownerId` (resolved from the personal
 * token) and returns a compact, agent-friendly string — never a raw blob.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ownerId: string, args: Record<string, unknown>) => Promise<string>;
}

// ---------- helpers ----------

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Resolve a workspace: explicit arg → the sole workspace → ask the caller. */
async function resolveWorkspace(ownerId: string, args: Record<string, unknown>): Promise<string> {
  const explicit = str(args.workspace_id);
  if (explicit) return explicit;
  const workspaces = await callApi<Workspace[]>(ownerId, 'GET', '/workspaces');
  if (workspaces.length === 1) return workspaces[0].id;
  if (workspaces.length === 0) {
    throw new Error('No workspaces found — create one in the Talyn app first.');
  }
  const list = workspaces.map((w) => `  ${w.id} — ${w.name}`).join('\n');
  throw new Error(`Multiple workspaces — pass workspace_id. Available:\n${list}`);
}

function flagsOf(pr: PublicPr): string {
  const flags: string[] = [];
  if (pr.summary.draft) flags.push('draft');
  if (pr.autoKeepMergeable) flags.push('auto-keep');
  if (pr.mergeQueued) flags.push(`merge-queued${pr.mergeQueue ? `:${pr.mergeQueue.status}` : ''}`);
  return flags.length ? `  [${flags.join(', ')}]` : '';
}

function prLine(pr: PublicPr): string {
  const c = pr.summary.checks;
  const checks = c.total > 0 ? `checks ${c.passed}/${c.total}${c.failed ? ` ✗${c.failed}` : ''}${c.inProgress ? ` ⧗${c.inProgress}` : ''}` : 'checks —';
  const review = pr.summary.effectiveReviewDecision ?? pr.summary.reviewDecision ?? 'none';
  return [
    pr.id,
    `#${pr.number} ${pr.owner}/${pr.repo}`,
    `[${pr.state}]`,
    `"${pr.summary.title}"`,
    checks,
    `mergeable:${pr.summary.mergeable}`,
    `review:${review}`,
  ].join('  ') + flagsOf(pr) + `\n    ${pr.summary.url}`;
}

function needsAttention(pr: PublicPr): boolean {
  const s = pr.summary;
  return (
    s.checks.failed > 0 ||
    s.mergeable === 'CONFLICTING' ||
    s.reviewDecision === 'CHANGES_REQUESTED' ||
    s.unresolvedReviewThreads > 0
  );
}

function taskLine(t: Task): string {
  return `- ${t.id}  [${t.status}]  ${t.type}  "${t.title}"`;
}

const BUCKET_TO_RELATIONSHIP: Record<string, string> = {
  mine: 'authored',
  review_requested: 'review_requested',
  needs_attention: 'authored',
  all: 'all',
};

// ---------- tool registry ----------

export const TOOLS: McpToolDefinition[] = [
  {
    name: 'talyn_list_workspaces',
    description:
      'List your Talyn workspaces (each groups GitHub repos + integrations). Use this to discover workspace ids for the other tools.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (ownerId) => {
      const workspaces = await callApi<Workspace[]>(ownerId, 'GET', '/workspaces');
      if (workspaces.length === 0) return 'No workspaces.';
      return workspaces
        .map((w) => {
          const repos = w.repos.map((r) => r.name).join(', ') || 'no repos';
          return `- ${w.id}  ${w.name}  (${repos})`;
        })
        .join('\n');
    },
  },
  {
    name: 'talyn_list_pull_requests',
    description:
      'List pull requests in a workspace by bucket: "mine" (you authored), "review_requested" (awaiting your review), "needs_attention" (your PRs failing checks / conflicting / with change-requests or unresolved threads), or "all". Returns one compact line per PR including its Talyn id (needed for the other PR tools).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Defaults to your only workspace.' },
        bucket: {
          type: 'string',
          enum: ['mine', 'review_requested', 'needs_attention', 'all'],
          description: 'Which set of PRs. Default: all.',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'merged', 'all'],
          description: 'PR state filter. Default: open.',
        },
        repo: { type: 'string', description: 'Filter by Talyn repository id.' },
        search: { type: 'string', description: 'Substring match on title or owner/repo.' },
      },
    },
    handler: async (ownerId, args) => {
      const ws = await resolveWorkspace(ownerId, args);
      const bucket = str(args.bucket) ?? 'all';
      const relationship = BUCKET_TO_RELATIONSHIP[bucket] ?? 'all';
      const params = new URLSearchParams({ workspaceId: ws, relationship });
      params.set('state', str(args.state) ?? 'open');
      if (str(args.repo)) params.set('repo', str(args.repo)!);
      if (str(args.search)) params.set('search', str(args.search)!);
      let prs = await callApi<PublicPr[]>(ownerId, 'GET', `/pull-requests?${params.toString()}`);
      if (bucket === 'needs_attention') prs = prs.filter(needsAttention);
      if (prs.length === 0) return `No pull requests (bucket: ${bucket}).`;
      return prs.map(prLine).join('\n');
    },
  },
  {
    name: 'talyn_get_pull_request',
    description:
      'Get a single PR\'s status and context: title, author, branches, mergeable state, review decision, blocking reason, checks breakdown, unresolved review threads, and merge-queue / auto-keep flags. Does not include the diff (use talyn_get_pull_request_diff) or full review threads (use talyn_get_pull_request_reviews).',
    inputSchema: {
      type: 'object',
      properties: { pull_request_id: { type: 'string', description: 'Talyn PR id.' } },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const { row } = await callApi<{ row: PublicPr }>(ownerId, 'GET', `/pull-requests/${id}`);
      const s: PrSummary = row.summary;
      const c = s.checks;
      const lines = [
        `${row.owner}/${row.repo}#${row.number}  [${row.state}]  "${s.title}" by ${s.author}`,
        `branches: ${s.headBranch} → ${s.baseBranch}`,
        `mergeable: ${s.mergeable} (${s.blockingReason})   review: ${s.effectiveReviewDecision ?? s.reviewDecision ?? 'none'}`,
        `checks: ${c.passed} passed / ${c.failed} failed / ${c.inProgress} in-progress / ${c.skipped} skipped / ${c.total} total`,
        `unresolved review threads: ${s.unresolvedReviewThreads}`,
        `auto-keep-mergeable: ${row.autoKeepMergeable}   merge-queued: ${row.mergeQueued}${row.mergeQueue ? ` (${row.mergeQueue.status}, position ${row.mergeQueue.position}${row.mergeQueue.reason ? `, ${row.mergeQueue.reason}` : ''})` : ''}   merge-method: ${row.mergeMethod}`,
        row.taskId ? `linked task: ${row.taskId}` : 'no linked task',
        s.url,
      ];
      return lines.join('\n');
    },
  },
  {
    name: 'talyn_get_pull_request_diff',
    description:
      'List the changed files in a PR with per-file +/- stats. By default returns only the file list; set include_patch to also return the unified diff (optionally scoped to a single path).',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        include_patch: { type: 'boolean', description: 'Include the unified-diff patch text. Default false.' },
        path: { type: 'string', description: 'Limit the patch to this file path.' },
      },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const includePatch = args.include_patch === true;
      const only = str(args.path);
      type FileEntry = {
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      };
      let files = await callApi<FileEntry[]>(ownerId, 'GET', `/pull-requests/${id}/files`);
      if (only) files = files.filter((f) => f.filename === only);
      if (files.length === 0) return only ? `No file matching ${only}.` : 'No changed files.';
      return files
        .map((f) => {
          const head = `${f.filename}  ${f.status}  +${f.additions}/-${f.deletions}`;
          if (includePatch && f.patch) return `${head}\n${f.patch}`;
          return head;
        })
        .join('\n');
    },
  },
  {
    name: 'talyn_get_pull_request_reviews',
    description:
      'Get the review context an agent needs to respond: submitted reviews (with verdict + body), inline review threads grouped by file/line (with the comment body), and top-level conversation comments. Defaults to unresolved threads only.',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        unresolved_only: { type: 'boolean', description: 'Only unresolved inline threads. Default true.' },
      },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const unresolvedOnly = args.unresolved_only !== false;
      type Review = { author: string; state: string; body: string };
      type ThreadComment = { author: string; body: string };
      type Thread = {
        isResolved: boolean;
        path: string | null;
        line: number | null;
        comments: ThreadComment[];
      };
      type Conv = { author: string; body: string };
      const detail = await callApi<{ reviews: Review[]; threads: Thread[]; comments: Conv[] }>(
        ownerId,
        'GET',
        `/pull-requests/${id}/reviews`
      );
      const out: string[] = [];

      const reviews = detail.reviews.filter((r) => r.body || r.state !== 'COMMENTED');
      if (reviews.length) {
        out.push('## Reviews');
        for (const r of reviews) out.push(`- ${r.author} ${r.state}${r.body ? `: ${trim(r.body)}` : ''}`);
      }

      const threads = detail.threads.filter((t) => (unresolvedOnly ? !t.isResolved : true));
      if (threads.length) {
        out.push('## Inline threads');
        for (const t of threads) {
          const loc = t.path ? `${t.path}${t.line != null ? `:${t.line}` : ''}` : '(general)';
          const first = t.comments[0];
          out.push(`- ${loc}${t.isResolved ? ' (resolved)' : ''} — ${first ? `${first.author}: ${trim(first.body)}` : ''}`);
          for (const c of t.comments.slice(1)) out.push(`    ↳ ${c.author}: ${trim(c.body)}`);
        }
      }

      if (detail.comments.length) {
        out.push('## Comments');
        for (const c of detail.comments) out.push(`- ${c.author}: ${trim(c.body)}`);
      }

      return out.length ? out.join('\n') : 'No reviews, threads, or comments.';
    },
  },
  {
    name: 'talyn_refresh_pull_request',
    description: 'Force a fresh fetch of a PR from GitHub (bypassing the cache) and return its updated summary line.',
    inputSchema: {
      type: 'object',
      properties: { pull_request_id: { type: 'string' } },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const pr = await callApi<PublicPr>(ownerId, 'POST', `/pull-requests/${id}/refresh`);
      return prLine(pr);
    },
  },
  {
    name: 'talyn_set_auto_keep_mergeable',
    description:
      'Enable or disable "auto keep mergeable" on a PR. When enabled, Talyn repeatedly fires a cloud fix run whenever the PR develops a blocker (conflicts, failing checks) so it stays mergeable.',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['pull_request_id', 'enabled'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const enabled = args.enabled === true;
      await callApi<null>(ownerId, 'POST', `/pull-requests/${id}/auto-keep-mergeable`, { enabled });
      return `Auto-keep-mergeable ${enabled ? 'enabled' : 'disabled'} for PR ${id}.`;
    },
  },
  {
    name: 'talyn_set_merge_queue',
    description:
      'Add a PR to (or remove it from) the Talyn merge queue. Queued PRs are merged automatically — serialized per base branch — as soon as they are clean, with cloud fix runs fired on conflict/behind/blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        enabled: { type: 'boolean' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method when its turn comes. Default keeps the current.' },
      },
      required: ['pull_request_id', 'enabled'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const enabled = args.enabled === true;
      const method = str(args.method);
      await callApi<null>(ownerId, 'POST', `/pull-requests/${id}/merge-queue`, {
        enabled,
        ...(method ? { method } : {}),
      });
      return `Merge queue ${enabled ? 'enabled' : 'disabled'}${method ? ` (method: ${method})` : ''} for PR ${id}.`;
    },
  },
  {
    name: 'talyn_merge_pull_request',
    description: 'Merge a PR now (merge | squash | rebase). Fails if GitHub reports the PR is not mergeable.',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Default squash.' },
      },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const method = str(args.method);
      const result = await callApi<{ merged: boolean; message?: string }>(
        ownerId,
        'POST',
        `/pull-requests/${id}/merge`,
        method ? { method } : {}
      );
      return result.merged ? `Merged PR ${id}.` : `Not merged: ${result.message ?? 'unknown reason'}`;
    },
  },
  {
    name: 'talyn_fix_pull_request',
    description:
      "Start the standard Talyn \"get this PR mergeable\" cloud run — the exact action behind the app's fix button. Using Talyn's standard prompt and the workspace's configured provider, the agent resolves reviewer comments, gets CI green, and cleanly merges the base branch, then opens/updates the PR. Takes only the PR id — no instructions needed (use talyn_create_task for freeform work).",
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        model: { type: 'string', description: 'Optional model id override (provider-specific).' },
      },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const model = str(args.model);
      const task = await callApi<Task>(
        ownerId,
        'POST',
        `/pull-requests/${id}/fix`,
        model ? { model } : {}
      );
      return `Started "${task.title}" — task ${task.id} (${task.status}).`;
    },
  },
  {
    name: 'talyn_create_task',
    description:
      'Create a freeform cloud coding task on a repository (not tied to an existing PR). The agent runs on the workspace provider and opens a PR.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Defaults to your only workspace.' },
        repository_id: { type: 'string', description: 'Talyn repository id to target (required).' },
        prompt: { type: 'string', description: 'What the agent should build.' },
        title: { type: 'string', description: 'Auto-derived from the prompt if omitted.' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['code_writing', 'pr_response', 'pr_review'], description: 'Default code_writing.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Default medium.' },
        model: { type: 'string' },
        pull_request_id: { type: 'string', description: 'Optionally link to an existing PR row.' },
      },
      required: ['repository_id', 'prompt'],
    },
    handler: async (ownerId, args) => {
      const ws = await resolveWorkspace(ownerId, args);
      const prompt = requireId(args, 'prompt');
      const body: CreateTaskRequest = {
        workspaceId: ws,
        type: (str(args.type) as TaskType | undefined) ?? 'code_writing',
        title: str(args.title) ?? deriveTitle(prompt),
        description: str(args.description) ?? '',
        prompt,
        priority: (str(args.priority) as CreateTaskRequest['priority']) ?? 'medium',
        repositoryId: requireId(args, 'repository_id'),
        pullRequestId: str(args.pull_request_id),
        model: str(args.model),
      };
      const task = await callApi<Task>(ownerId, 'POST', '/tasks', body);
      return `Created ${task.type} task ${task.id}: "${task.title}" (${task.status}).`;
    },
  },
  {
    name: 'talyn_list_tasks',
    description: 'List cloud tasks in a workspace, optionally filtered by status or type.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        status: { type: 'string', description: 'queued | in_progress | completed | failed | cancelled' },
        type: { type: 'string', description: 'code_writing | pr_response | pr_review' },
      },
    },
    handler: async (ownerId, args) => {
      const ws = await resolveWorkspace(ownerId, args);
      const params = new URLSearchParams({ workspaceId: ws });
      if (str(args.status)) params.set('status', str(args.status)!);
      if (str(args.type)) params.set('type', str(args.type)!);
      const tasks = await callApi<Task[]>(ownerId, 'GET', `/tasks?${params.toString()}`);
      return tasks.length ? tasks.map(taskLine).join('\n') : 'No tasks.';
    },
  },
  {
    name: 'talyn_get_task',
    description:
      'Get a cloud task\'s status, result summary, and linked PR. Set include_transcript to also return the raw run transcript (can be large).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        include_transcript: { type: 'boolean', description: 'Default false.' },
      },
      required: ['task_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'task_id');
      const task = await callApi<Task>(ownerId, 'GET', `/tasks/${id}`);
      const meta = (task.metadata ?? {}) as Record<string, unknown>;
      const cloud = (meta.cloudTask ?? {}) as Record<string, unknown>;
      const prUrl = (cloud.prUrl as string) ?? (meta.posthogPrUrl as string) ?? null;
      const lines = [
        `${task.id}  [${task.status}]  ${task.type}  "${task.title}"`,
        task.branch ? `branch: ${task.branch}` : null,
        prUrl ? `PR: ${prUrl}` : null,
        task.result ? `result: ${trim(JSON.stringify(task.result), 600)}` : null,
      ].filter(Boolean) as string[];
      if (args.include_transcript === true && task.transcript) {
        lines.push('--- transcript ---', trim(JSON.stringify(task.transcript), 8000));
      }
      return lines.join('\n');
    },
  },
  {
    name: 'talyn_stop_task',
    description: 'Cancel a running cloud task (best-effort remote cancel; the task lands in "cancelled").',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'task_id');
      const task = await callApi<Task>(ownerId, 'POST', `/tasks/${id}/stop`);
      return `Stopped task ${id} (${task.status}).`;
    },
  },
  {
    name: 'talyn_retry_task',
    description: 'Re-queue a failed or cancelled cloud task for another run.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'task_id');
      const task = await callApi<Task>(ownerId, 'POST', `/tasks/${id}/retry`);
      return `Re-queued task ${id} (${task.status}).`;
    },
  },
];

// ---------- tiny utils ----------

function requireId(args: Record<string, unknown>, key: string): string {
  const v = str(args[key]);
  if (!v) throw new Error(`${key} is required`);
  return v;
}

function deriveTitle(prompt: string): string {
  return prompt.split('\n')[0].trim().slice(0, 80) || 'New task';
}

function trim(s: string, max = 280): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
