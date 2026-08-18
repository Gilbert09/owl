import { EventEmitter } from 'node:events';
import type { TaskStatus } from '@talyn/shared';
import { debugBus } from './debugBus.js';

export interface DomainTaskStatusEvent {
  workspaceId: string;
  taskId: string;
  status: TaskStatus;
}

/**
 * A fresh PR snapshot was just written to pull_requests (prCache upsert, or
 * an incremental webhook patch). The merge-queue v2 evaluator keys off this:
 * the event IS the freshness signal — evaluation runs against state written
 * milliseconds ago, no re-fetch needed.
 */
export interface DomainPrSnapshotEvent {
  workspaceId: string;
  repositoryId: string;
  prId: string;
  /** From the fresh summary — the merge-queue group key. */
  baseBranch: string;
  /**
   * From the fresh summary. When this PR goes terminal, its HEAD branch is the
   * group key of every entry stacked on it — and nothing else would ever
   * schedule that group, because all of their triggers key on the base they're
   * parked on. Optional: the check-count fast path has no summary in hand, and
   * the trigger falls back to a PK lookup there.
   */
  headBranch?: string;
  state: 'open' | 'closed' | 'merged';
  /** What produced the snapshot ('prcache:upsert', 'webhook:patch', …). */
  trigger: string;
}

/**
 * The incremental check-count fast path just recomputed pill counts for these
 * PRs (check_run webhooks never reach a full refreshPr). This is the
 * "checks finished → merge now" signal for the merge-queue v2 evaluator.
 */
export interface DomainPrChecksEvent {
  prs: Array<{ prId: string; workspaceId: string; repositoryId: string }>;
}

interface DomainEvents {
  on(event: 'task:status', listener: (evt: DomainTaskStatusEvent) => void): DomainEventEmitter;
  on(event: 'pr:snapshot', listener: (evt: DomainPrSnapshotEvent) => void): DomainEventEmitter;
  on(event: 'pr:checks', listener: (evt: DomainPrChecksEvent) => void): DomainEventEmitter;
  off(event: 'task:status', listener: (evt: DomainTaskStatusEvent) => void): DomainEventEmitter;
  off(event: 'pr:snapshot', listener: (evt: DomainPrSnapshotEvent) => void): DomainEventEmitter;
  off(event: 'pr:checks', listener: (evt: DomainPrChecksEvent) => void): DomainEventEmitter;
  emit(event: 'task:status', evt: DomainTaskStatusEvent): boolean;
  emit(event: 'pr:snapshot', evt: DomainPrSnapshotEvent): boolean;
  emit(event: 'pr:checks', evt: DomainPrChecksEvent): boolean;
}

class DomainEventEmitter extends EventEmitter implements DomainEvents {}

/**
 * In-process event bus for server-side listeners. Websocket broadcast is a
 * separate concern — it goes to clients; this one goes to other backend
 * services that need to react to state transitions (e.g. the merge-queue v2
 * evaluator reacts to fresh PR snapshots, check-count flushes, and tasks
 * hitting terminal states). Deliberately a leaf module: emitters and
 * listeners both import it, never each other.
 */
export const domainEvents = new DomainEventEmitter();

// Mirror domain events into the developer Debug stream. pr:snapshot /
// pr:checks are NOT mirrored — they fire on every PR refresh and would drown
// the Debug panel's event stream; the evaluator records its own decisions.
domainEvents.on('task:status', (evt) => {
  debugBus.recordEvent({
    service: 'tasks',
    action: 'task:status',
    summary: `task ${evt.taskId.slice(0, 8)} → ${evt.status}`,
    meta: { taskId: evt.taskId, status: evt.status, workspaceId: evt.workspaceId },
  });
});
