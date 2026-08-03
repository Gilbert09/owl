import { useCallback, useEffect, useState } from 'react';
import type { AdminAccess } from '@talyn/shared';
import { api } from '../lib/api';

/**
 * Three outcomes, not two.
 *
 * `{admin:false}` and "the request never completed" are DIFFERENT ANSWERS and
 * must render differently. apps/web's offlineBanner.test.tsx exists because
 * that distinction was collapsed elsewhere: a transport failure got recorded
 * as an authoritative negative and rendered as an alarming, actionable-looking,
 * wrong message. Here the equivalent mistake would tell an operator they had
 * been de-admined during an outage.
 *
 * 'checking' → still asking. 'admin'/'denied' → the server answered.
 * 'error' → we never got an answer, and `retry` is the only sensible response.
 */
export type AdminAccessState = 'checking' | 'admin' | 'denied' | 'error';

export interface UseAdminAccess {
  state: AdminAccessState;
  access: AdminAccess | null;
  error: string | null;
  retry: () => void;
}

export function useAdminAccess(): UseAdminAccess {
  const [state, setState] = useState<AdminAccessState>('checking');
  const [access, setAccess] = useState<AdminAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('checking');
    setError(null);

    api.admin
      .me()
      .then((result) => {
        if (cancelled) return;
        setAccess(result);
        setState(result.admin ? 'admin' : 'denied');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Deliberately NOT 'denied'. We do not know.
        setAccess(null);
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { state, access, error, retry };
}
