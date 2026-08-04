import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * The frame every console page shares: a title, an optional back link, and a
 * refresh affordance.
 *
 * The refresh button is manual on purpose even though pages poll. During an
 * incident the poll interval always feels too slow, and an operator who cannot
 * force a read will reload the whole page — losing their filters and every
 * other panel's state to get one number.
 */
export function Page({
  title,
  subtitle,
  backTo,
  backLabel,
  actions,
  onRefresh,
  refreshing,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  backTo?: string;
  backLabel?: string;
  actions?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="p-6">
      {backTo && (
        <Link
          to={backTo}
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" />
          {backLabel ?? 'Back'}
        </Link>
      )}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate font-display text-lg font-semibold">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {onRefresh && (
            <button
              onClick={onRefresh}
              aria-label="Refresh"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              Refresh
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/** A small coloured pill. The console's one status vocabulary. */
export function Pill({
  tone = 'default',
  children,
  title,
}: {
  tone?: 'default' | 'good' | 'warn' | 'critical' | 'muted';
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'good' &&
          'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        tone === 'warn' && 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        tone === 'critical' && 'border-destructive/40 bg-destructive/10 text-destructive',
        tone === 'muted' && 'border-border text-muted-foreground',
        tone === 'default' && 'border-border'
      )}
    >
      {children}
    </span>
  );
}
