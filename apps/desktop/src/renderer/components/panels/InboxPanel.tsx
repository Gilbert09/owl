import React from 'react';
import {
  MessageSquare,
  GitPullRequest,
  AlertCircle,
  CheckCircle,
  Clock,
  MoreHorizontal,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import type { InboxItem, InboxItemType } from '@fastowl/shared';

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
  const { inboxItems, markInboxRead, markInboxActioned } = useWorkspaceStore();

  const unreadItems = inboxItems.filter((i) => i.status === 'unread');
  const readItems = inboxItems.filter((i) => i.status === 'read');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <h2 className="text-lg font-semibold">Inbox</h2>
          <p className="text-sm text-muted-foreground">
            {unreadItems.length} items need attention
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            Mark all read
          </Button>
        </div>
      </div>

      {/* Content */}
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
            {unreadItems.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
                  NEW
                </h3>
                <div className="space-y-2">
                  {unreadItems.map((item) => (
                    <InboxItemCard
                      key={item.id}
                      item={item}
                      onRead={() => markInboxRead(item.id)}
                      onAction={() => markInboxActioned(item.id)}
                    />
                  ))}
                </div>
              </div>
            )}
            {readItems.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
                  EARLIER
                </h3>
                <div className="space-y-2">
                  {readItems.map((item) => (
                    <InboxItemCard
                      key={item.id}
                      item={item}
                      onRead={() => markInboxRead(item.id)}
                      onAction={() => markInboxActioned(item.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface InboxItemCardProps {
  item: InboxItem;
  onRead: () => void;
  onAction: () => void;
}

function InboxItemCard({ item, onRead, onAction }: InboxItemCardProps) {
  const Icon = typeIcons[item.type] || Clock;
  const isUnread = item.status === 'unread';

  return (
    <Card
      className={cn(
        'p-3 border-l-4 cursor-pointer transition-colors hover:bg-accent/50',
        priorityColors[item.priority],
        isUnread && 'bg-accent/30'
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
                onAction();
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
