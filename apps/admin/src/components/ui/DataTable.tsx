import { type ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { cn } from '../../lib/utils';

/**
 * One table shell, so every list in the console treats its three non-happy
 * states identically.
 *
 * The distinction this exists to enforce: **an empty result and a failed
 * request are different**, and they must not look the same. "No hosts have
 * reported" is a fact about the fleet; "we could not reach the backend" is a
 * fact about us. Rendering the first when the second is true tells an operator
 * the fleet is gone, which is the `offlineBanner.test.tsx` bug with much
 * higher stakes — they might go and restart something.
 *
 * A background refresh never blanks the table: when `rows` is non-empty the
 * data stays put and `loading` shows as a small spinner in the header, because
 * a poll tick that flashes the empty state reads as the fleet dropping out.
 */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell renderer. Kept explicit rather than key-based so a cell can compose. */
  cell: (row: T) => ReactNode;
  className?: string;
  headClassName?: string;
}

export interface DataTableProps<T> {
  rows: T[] | null;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Shown when the request failed. Takes precedence over the empty state. */
  error?: string | null;
  loading?: boolean;
  initialLoading?: boolean;
  onRetry?: () => void;
  /** What "there is genuinely nothing here" should say. Be specific. */
  emptyMessage?: string;
  emptyHint?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  error,
  loading,
  initialLoading,
  onRetry,
  emptyMessage = 'Nothing here.',
  emptyHint,
  onRowClick,
  rowClassName,
}: DataTableProps<T>) {
  const hasRows = rows != null && rows.length > 0;

  // Never got an answer, and nothing cached to fall back on.
  if (error && !hasRows) {
    return (
      <StateBlock
        icon={<AlertTriangle className="h-5 w-5 text-destructive" />}
        title="Couldn't load this"
        body={error}
        action={
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Try again
            </button>
          )
        }
      />
    );
  }

  if (initialLoading && !hasRows) {
    return (
      <StateBlock
        icon={<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        title="Loading…"
      />
    );
  }

  if (!hasRows) {
    return (
      <StateBlock
        icon={<Inbox className="h-5 w-5 text-muted-foreground" />}
        title={emptyMessage}
        body={typeof emptyHint === 'string' ? emptyHint : undefined}
        action={typeof emptyHint === 'string' ? undefined : emptyHint}
      />
    );
  }

  return (
    <div className="space-y-2">
      {/* A stale-data banner rather than an empty page: the numbers below are
          the last good ones, and saying so is more useful than hiding them. */}
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error} Showing the last data we had.</span>
          {onRetry && (
            <button onClick={onRetry} className="ml-auto underline hover:no-underline">
              Retry
            </button>
          )}
        </div>
      )}
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col.key} className={col.headClassName}>
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows!.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(onRowClick && 'cursor-pointer', rowClassName?.(row))}
              >
                {columns.map((col) => (
                  <TableCell key={col.key} className={col.className}>
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {loading && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Refreshing…
        </div>
      )}
    </div>
  );
}

function StateBlock({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-6 py-12 text-center">
      <div className="flex justify-center">{icon}</div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>}
      {action}
    </div>
  );
}
