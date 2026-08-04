import { type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * A headline number with a label, and optionally a bar.
 *
 * `value` is a string rather than a number so the caller does the formatting —
 * "—" for unknown is a first-class value here, and forcing it through a
 * numeric type is how "we don't know" becomes "0".
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  /** 0–100, or null when the denominator is unknown (see format.pct). */
  barPct,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'warn' | 'critical' | 'good';
  barPct?: number | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-display text-xl font-semibold tabular-nums',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          tone === 'critical' && 'text-destructive',
          tone === 'good' && 'text-emerald-600 dark:text-emerald-400'
        )}
      >
        {value}
      </div>
      {barPct != null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              barPct >= 90
                ? 'bg-destructive'
                : barPct >= 70
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
            )}
            style={{ width: `${barPct}%` }}
          />
        </div>
      )}
      {hint && <div className="mt-1.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
