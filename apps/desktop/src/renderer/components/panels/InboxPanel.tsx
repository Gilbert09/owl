import React, { useState } from 'react';
import {
  MessageSquare,
  GitPullRequest,
  AlertCircle,
  CheckCircle,
  Clock,
  MoreHorizontal,
  Shield,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { api } from '../../lib/api';
import type { InboxItem, InboxItemType, InboxAction } from '@fastowl/shared';

const typeIcons: Record<InboxItemType, React.ElementType> = {
  agent_question: MessageSquare,
  agent_completed: CheckCircle,
  agent_error: AlertCircle,
  pr_review: GitPullRequest,
  pr_ci_failure: AlertCircle,
  pr_ready_to_merge: GitPullRequest,
  slack_mention: MessageSquare,
  posthog_alert: AlertCircle,
  custom: Clock,
};

const priorityColors = {
  low: 'border-l-slate-400',
  medium: 'border-l-blue-400',
  high: 'border-l-yellow-400',
  urgent: 'border-l-red-400',
};

export function InboxPanel() {
  const {
    inboxItems,
    markInboxRead,
    markInboxActioned,
    selectTask,
    setActivePanel,
  } = useWorkspaceStore();

  const unreadCount = inboxItems.filter((i) => i.status === 'unread').length;

  /**
   * Dispatch an inbox action. `view_task` + `view_agent` just
   * navigate; they don't mark the item `actioned` (user might want
   * to come back). Everything else falls through to "mark actioned"
   * which hides the item from the "NEW" bucket.
   */
  const handleAction = async (item: InboxItem, action: InboxAction) => {
    if (action.action === 'view_task' || action.action === 'view_agent') {
      if (item.status === 'unread') {
        markInboxRead(item.id);
        void api.inbox.markRead(item.id).catch((err) =>
          console.error('[inbox] markRead failed:', err)
        );
      }
      const sourceId = item.source.id;
      if (sourceId) {
        selectTask(sourceId);
        setActivePanel('queue');
      }
      return;
    }
    markInboxActioned(item.id);
    void api.inbox.markActioned(item.id).catch((err) =>
      console.error('[inbox] markActioned failed:', err)
    );
  };

  const handleRead = (item: InboxItem) => {
    if (item.status !== 'unread') return;
    markInboxRead(item.id);
    void api.inbox.markRead(item.id).catch((err) =>
      console.error('[inbox] markRead failed:', err)
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <h2 className="text-lg font-semibold">Inbox</h2>
          <p className="text-sm text-muted-foreground">
            {unreadCount} {unreadCount === 1 ? 'item needs' : 'items need'} attention
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            Mark all read
          </Button>
        </div>
      </div>

      {/* Content — single ordered list. Read/actioned items stay
          visible (dimmed) so clicking an unread item doesn't feel
          like the card vanished. */}
      <ScrollArea className="flex-1">
        {inboxItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center p-4">
            <CheckCircle className="w-12 h-12 text-muted-foreground/50 mb-4" />
            <h3 className="font-medium mb-1">All caught up!</h3>
            <p className="text-sm text-muted-foreground">
              No items need your attention right now.
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {inboxItems.map((item) => (
              <InboxItemCard
                key={item.id}
                item={item}
                onRead={() => handleRead(item)}
                onAction={(action) => handleAction(item, action)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface InboxItemCardProps {
  item: InboxItem;
  onRead: () => void;
  onAction: (action: InboxAction) => void;
}

function InboxItemCard({ item, onRead, onAction }: InboxItemCardProps) {
  const Icon = typeIcons[item.type] || Clock;
  const isUnread = item.status === 'unread';
  const isActioned = item.status === 'actioned';
  const permission = extractPermissionContext(item);

  return (
    <Card
      className={cn(
        'p-3 border-l-4 cursor-pointer transition-colors hover:bg-accent/50',
        priorityColors[item.priority],
        isUnread && 'bg-accent/30',
        isActioned && 'opacity-60'
      )}
      onClick={onRead}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
            item.type.includes('error') || item.type.includes('failure')
              ? 'bg-red-500/10 text-red-500'
              : item.type.includes('completed') || item.type.includes('merge')
              ? 'bg-green-500/10 text-green-500'
              : 'bg-blue-500/10 text-blue-500'
          )}
        >
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'text-sm font-medium truncate',
                isUnread && 'font-semibold'
              )}
            >
              {item.title}
            </span>
            {isUnread && (
              <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
            )}
            {isActioned && (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                Done
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {item.summary}
          </p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="outline" className="text-xs">
              {item.source.name || item.source.type}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {formatTime(item.createdAt)}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </div>
      {permission && !isActioned && (
        <div
          className="mt-3 ml-11"
          onClick={(e) => e.stopPropagation()}
        >
          <InboxPermissionControls
            taskId={String(item.source.id ?? '')}
            requestId={permission.requestId}
            toolName={permission.toolName}
            toolInput={permission.toolInput}
          />
        </div>
      )}
      {item.actions.length > 0 && (
        <div className="flex gap-2 mt-3 ml-11">
          {item.actions.slice(0, 2).map((action) => (
            <Button
              key={action.id}
              variant={action.type === 'primary' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onAction(action);
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Shape of the `data` blob that `permissionInbox` stores on
 * `agent_question` inbox items. Optional because other item types
 * (agent_completed, pr_review, etc.) don't set it.
 */
interface InboxPermissionData {
  latestRequestId?: string;
  latestTool?: string;
  latestToolInput?: unknown;
  pendingRequestIds?: string[];
}

function extractPermissionContext(item: InboxItem): {
  requestId: string;
  toolName: string;
  toolInput: unknown;
} | null {
  if (item.type !== 'agent_question') return null;
  const data = item.data as InboxPermissionData | undefined;
  if (!data) return null;
  if (!data.latestRequestId || !data.latestTool) return null;
  if (!data.pendingRequestIds || data.pendingRequestIds.length === 0) return null;
  return {
    requestId: data.latestRequestId,
    toolName: data.latestTool,
    toolInput: data.latestToolInput,
  };
}

/**
 * Inline Approve / Deny controls rendered directly on the inbox
 * card. Same backend endpoint as the task-panel permission card —
 * once the response lands, the permissionInbox service auto-marks
 * the item `actioned` and emits `inbox:update`, so the card dims
 * itself without a refresh.
 */
function InboxPermissionControls({
  taskId,
  requestId,
  toolName,
  toolInput,
}: {
  taskId: string;
  requestId: string;
  toolName: string;
  toolInput: unknown;
}) {
  const [busy, setBusy] = useState<null | 'allow' | 'deny' | 'allow-always'>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (decision: 'allow' | 'deny', persist: boolean) => {
    const btn = decision === 'deny' ? 'deny' : persist ? 'allow-always' : 'allow';
    setBusy(btn);
    setError(null);
    try {
      await api.tasks.respondToPermission(taskId, requestId, decision, persist);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to respond');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded border border-yellow-500/30 bg-yellow-500/5 p-2.5">
      <div className="flex items-center gap-2 text-xs mb-2">
        <Shield className="w-3.5 h-3.5 text-yellow-500" />
        <span className="font-semibold">Approve {toolName}?</span>
      </div>
      <PermissionInputPreview toolName={toolName} toolInput={toolInput} />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => respond('allow', false)} disabled={busy !== null}>
          {busy === 'allow' ? '…' : 'Allow once'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => respond('allow', true)}
          disabled={busy !== null}
          title="Pre-approve this tool on this environment"
        >
          {busy === 'allow-always' ? '…' : `Allow always (${toolName})`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-red-500 hover:text-red-600"
          onClick={() => respond('deny', false)}
          disabled={busy !== null}
        >
          {busy === 'deny' ? '…' : 'Deny'}
        </Button>
        {error && (
          <span className="text-xs text-red-500 self-center">{error}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Light-weight version of AgentConversation's ToolInputPreview —
 * same "pick the decision-relevant field per tool" idea but trimmed
 * for the inbox's tighter density.
 */
function PermissionInputPreview({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: unknown;
}) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;

  const rows: Array<{ label: string; value: string; mono?: boolean }> = [];
  const add = (label: string, value: unknown, mono = false) => {
    if (value === undefined || value === null || value === '') return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    rows.push({ label, value: truncate(text, 220), mono });
  };

  switch (toolName) {
    case 'Bash':
      add('command', input.command, true);
      add('description', input.description);
      break;
    case 'Grep':
      add('pattern', input.pattern, true);
      add('path', input.path, true);
      add('glob', input.glob, true);
      break;
    case 'Glob':
      add('pattern', input.pattern, true);
      add('path', input.path, true);
      break;
    case 'Read':
      add('file', input.file_path, true);
      break;
    case 'Edit':
    case 'Write':
      add('file', input.file_path, true);
      break;
    case 'WebFetch':
    case 'WebSearch':
      add('url', input.url, true);
      add('query', input.query);
      break;
    case 'Task':
    case 'Agent':
      add('description', input.description);
      add('subagent', input.subagent_type);
      break;
    default: {
      // Unknown tool — pick the first two string fields if nothing
      // matched. Keeps the card useful without blowing out the JSON.
      const entries = Object.entries(input).slice(0, 3);
      for (const [k, v] of entries) {
        add(k, v, typeof v === 'string');
      }
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="bg-black/30 rounded p-2 space-y-1 text-xs">
      {rows.map((row) => (
        <div key={row.label} className="flex gap-2 items-baseline">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
            {row.label}
          </span>
          <span
            className={cn(
              'break-all',
              row.mono && 'font-mono'
            )}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function formatTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
