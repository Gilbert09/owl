import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiNetworkError } from '@talyn/client';

/**
 * Fetch-and-poll for a console page.
 *
 * Deliberately not a data-fetching library: this app has ~8 pages, each with
 * one or two reads, and the requirements are narrow enough to state in full.
 *
 * The two that matter:
 *
 * 1. **"No data" and "we could not ask" are different states.** `data === null`
 *    with `error === null` means still loading; `error` set means we never got
 *    an answer, and the page must say so rather than render an empty table
 *    that reads as "the fleet is idle". This is the same distinction
 *    AdminGate makes, one layer down, and it is the one people collapse.
 *
 * 2. **Polling pauses when the tab is hidden.** An operator leaves this open
 *    all day; a 5s poll against a fan-out endpoint that dials every fleet host
 *    is not something to run into a backgrounded tab forever.
 *
 * A refresh never blanks the view — `data` holds the last good value while the
 * next request is in flight, so a poll tick does not make the table flicker
 * through its empty state.
 */

export interface AdminQueryState<T> {
  data: T | null;
  /** Set only when we never got an answer. Never set alongside fresh data. */
  error: string | null;
  /** True while a request is in flight, including background refreshes. */
  loading: boolean;
  /** True only for the very first load, when there is nothing to show yet. */
  initialLoading: boolean;
  refresh: () => void;
}

export interface AdminQueryOptions {
  /** Poll interval in ms. Omit for a one-shot read. */
  intervalMs?: number;
  /** Re-run whenever any of these change. */
  deps?: unknown[];
  /** Skip fetching entirely (e.g. a param is not ready yet). */
  enabled?: boolean;
}

export function useAdminQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: AdminQueryOptions = {}
): AdminQueryState<T> {
  const { intervalMs, deps = [], enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(enabled);
  const [tick, setTick] = useState(0);

  // Held in a ref so the effect does not re-run every render just because the
  // caller passed an inline arrow function.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setInitialLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function run() {
      setLoading(true);
      try {
        const value = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(value);
        setError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        // Keep the last good `data`. A transient failure mid-incident should
        // leave the numbers on screen with a banner, not wipe the page.
        setError(describe(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setInitialLoading(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // NOTE: `deps` is spread into the dependency array deliberately, so a
    // page can re-fetch on a route param or filter change. This repo does not
    // configure react-hooks/exhaustive-deps, so there is no lint suppression
    // here to keep in step — but the rule would flag it if it were enabled,
    // and the answer would still be "yes, on purpose".
  }, [tick, enabled, ...deps]);

  // Poll, paused while the tab is hidden.
  useEffect(() => {
    if (!enabled || !intervalMs) return;

    let timer: number | undefined;
    const start = () => {
      stop();
      timer = window.setInterval(refresh, intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Catch up immediately on return rather than waiting a full interval —
        // the first thing an operator does on coming back is look at the
        // numbers.
        refresh();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, refresh]);

  return { data, error, loading, initialLoading, refresh };
}

function describe(err: unknown): string {
  if (err instanceof ApiNetworkError) {
    return navigator.onLine
      ? "Couldn't reach the Talyn backend."
      : "You're offline — this is the last data we had.";
  }
  return err instanceof Error ? err.message : String(err);
}
