import type { CloudProviderType, Environment, Task, TaskStatus } from '@talyn/shared';

/**
 * A cloud task provider delegates a FastOwl task to a vendor that runs the
 * whole agent loop on its own sandbox and (usually) opens a PR. FastOwl
 * kicks off the remote run, ingests its transcript, and reconciles its
 * status back onto the local task. PostHog Code is the first (and currently
 * only) provider; Codex Cloud and Claude Routines are the planned drop-ins.
 *
 * See docs/CLOUD_PROVIDERS.md for the full design.
 */
export interface CloudTaskProvider {
  /** Stable id; matches the env-marker `type` and `task.provider`. */
  readonly type: CloudProviderType;
  /** Human label for Settings / composer UI. */
  readonly displayName: string;
  /** UI capability hints (which controls the composer should render). */
  readonly capabilities?: CloudProviderCapabilities;

  /** Validate + persist credentials from the Settings → Integrations form. */
  validateCredentials(
    workspaceId: string,
    input: unknown,
  ): Promise<{ ok: boolean; error?: string }>;
  /** True if this workspace has usable credentials stored. */
  hasCredentials(workspaceId: string): Promise<boolean>;
  /** Live check that the stored credentials still authenticate. */
  testConnection?(workspaceId: string): Promise<{ connected: boolean; error?: string }>;
  /** Remove this workspace's credentials. */
  removeCredentials(workspaceId: string): Promise<void>;

  /**
   * Kick off a remote run for `task`. Stamps `metadata.cloudTask` (and the
   * legacy `posthog*` fields for back-compat), flips the task to
   * `in_progress`, and starts streaming the transcript. The poller owns the
   * task from here. Idempotent: a task that already carries a remote id is a
   * no-op. `env` is the secret-free cloud marker the task is assigned to.
   */
  dispatch(task: Task, env: Environment): Promise<DispatchResult>;

  /**
   * Reconcile one in-progress task against its remote run: refresh status,
   * keep the transcript stream alive, link the PR, and finalize the task
   * when the remote run reaches a terminal state. Called every poll tick.
   */
  reconcile(taskRow: CloudTaskRow): Promise<void>;

  /** Tear down any live transcript stream for a task (on stop/delete). */
  stopStreaming(taskId: string): void;

  /**
   * Cancel the remote run backing `task`, if the vendor supports it.
   * Best-effort: resolve credentials + remote ids from the task metadata
   * and tell the vendor to stop. Throw on hard failure so the caller can
   * surface it; a task with no remote run yet should be a no-op.
   */
  cancel?(task: Task): Promise<void>;
}

export type DispatchResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /**
       * True when the dispatch failed for AVAILABILITY rather than because
       * anything is wrong with the task — the host is full, draining, out of
       * disk, or unreachable. The task queue falls these back to the next
       * provider in the workspace's order (§10.7, §11.6) instead of failing the
       * user's task.
       *
       * A discriminator rather than a string prefix on `error`. The selfhosted
       * executor used to signal this by prefixing "No fleet capacity:" and
       * saying so in a comment, which makes the routing decision depend on
       * message wording that any later edit is free to change.
       */
      capacity?: boolean;
    };

export interface CloudProviderCapabilities {
  /** Show a model picker in the composer. */
  model?: boolean;
  /** Show a runtime-adapter picker (e.g. claude vs codex). */
  runtimeAdapter?: boolean;
}

/** The minimal task row the poller hands to `reconcile`. */
export interface CloudTaskRow {
  id: string;
  workspaceId: string;
  title: string;
  repositoryId: string | null;
  metadata: Record<string, unknown>;
  transcriptEmpty: boolean;
  /** A desktop client is viewing this task (taskWatch registry) — gates
   *  whether the provider keeps a live transcript stream open. */
  watched: boolean;
  /**
   * Local task status. The poller loads `in_progress` tasks plus revival
   * candidates — `completed` tasks a provider optimistically finalised while
   * the remote run was still active (`metadata.reviveEligible`). Providers
   * branch on this to detect a run that has resumed since it was finalised.
   */
  status: TaskStatus;
  /**
   * When the task was finalised. The reference point for revival: a remote run
   * whose activity has advanced past this has resumed since we gave up on it.
   * Null unless the task is completed.
   */
  completedAt: Date | null;
  /**
   * When the task row last changed — which, for an `in_progress` task, is when
   * it started. It is how a provider tells a task that is mid-dispatch from one
   * that never dispatched at all: both look identical in a single tick, and only
   * the elapsed time separates them.
   */
  updatedAt: Date | null;
}
