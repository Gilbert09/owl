import { create } from 'zustand';

export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  /** Optional second line — e.g. the reason a merge was rejected. */
  description?: string;
}

interface ToastState {
  toasts: Toast[];
  add: (t: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
}

// Monotonic id — `Date.now()` alone collides when two toasts fire in the
// same tick (e.g. a failure that pushes both an error and a hint).
let counter = 0;
function nextId(): string {
  counter += 1;
  return `toast-${counter}`;
}

// Errors linger longer so there's time to actually read *why* something
// failed; success/info are transient acknowledgements.
const DEFAULT_TTL_MS = 5_000;
const ERROR_TTL_MS = 10_000;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (t) => {
    const id = nextId();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

function show(
  variant: ToastVariant,
  title: string,
  description?: string,
  ttl = DEFAULT_TTL_MS
): string {
  const id = useToastStore.getState().add({ variant, title, description });
  if (ttl > 0) {
    window.setTimeout(() => useToastStore.getState().dismiss(id), ttl);
  }
  return id;
}

/**
 * Fire-and-forget toast helper, usable from anywhere (event handlers,
 * stores, plain functions) without a hook. Render `<Toaster />` once at
 * the app root to surface them.
 */
export const toast = {
  success: (title: string, description?: string) => show('success', title, description),
  info: (title: string, description?: string) => show('info', title, description),
  error: (title: string, description?: string) =>
    show('error', title, description, ERROR_TTL_MS),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
