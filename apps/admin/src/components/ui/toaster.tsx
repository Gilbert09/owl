import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToastStore, type ToastVariant } from '../../stores/toast';

const VARIANT: Record<
  ToastVariant,
  { ring: string; icon: typeof Info; iconColor: string }
> = {
  success: {
    ring: 'border-emerald-500/30',
    icon: CheckCircle2,
    iconColor: 'text-emerald-600 dark:text-emerald-400',
  },
  error: {
    ring: 'border-red-500/40',
    icon: AlertCircle,
    iconColor: 'text-red-600 dark:text-red-400',
  },
  info: {
    ring: 'border-border',
    icon: Info,
    iconColor: 'text-muted-foreground',
  },
};

/**
 * App-wide toast surface. Mount once near the root. Reads from the
 * `useToastStore` zustand store that the `toast` helper writes to.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const { ring, icon: Icon, iconColor } = VARIANT[t.variant];
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-background p-3 shadow-lg',
              ring
            )}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconColor)} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                  {t.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
