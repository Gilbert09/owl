import { useCallback, useState } from 'react';
import { toast } from '../stores/toast';

/**
 * Open a confirm dialog, run a mutation, refresh the page behind it.
 *
 * The dialog owns the reason, the typed confirmation and the idempotency key;
 * this owns which mutation is pending and what happens after. Keeping them
 * apart means a page wires up a button without deciding anything about the
 * safeguards.
 */
export interface PendingMutation<T> {
  target: T;
  run: (input: { reason: string; confirm?: string }) => Promise<void>;
}

export function useAdminMutation<T>(onSuccess?: () => void) {
  const [pending, setPending] = useState<PendingMutation<T> | null>(null);

  const start = useCallback(
    (target: T, fn: (input: { reason: string; confirm?: string }) => Promise<unknown>) => {
      setPending({
        target,
        run: async (input) => {
          // Deliberately NOT caught here: the dialog needs the rejection to
          // stay open with the typed reason intact. Swallowing it would close
          // the dialog on failure and look like success.
          await fn(input);
          onSuccess?.();
        },
      });
    },
    [onSuccess]
  );

  const close = useCallback(() => setPending(null), []);

  const succeeded = useCallback((message: string) => toast.success(message), []);

  return { pending, start, close, succeeded };
}
