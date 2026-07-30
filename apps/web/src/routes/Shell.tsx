import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api, wsClient } from '@talyn/client';
import type { Workspace } from '@talyn/shared';
import { useAuth } from '../components/auth/AuthProvider';
import { PANEL_PATHS, panelForPath } from '../lib/routes';

const NAV: Array<{ path: string; label: string }> = [
  { path: PANEL_PATHS.my_prs, label: 'My PRs' },
  { path: PANEL_PATHS.reviews, label: 'Reviews' },
  { path: PANEL_PATHS.merge_queue, label: 'Merge queue' },
  { path: PANEL_PATHS.queue, label: 'Tasks' },
  { path: PANEL_PATHS.settings, label: 'Settings' },
];

/**
 * SCAFFOLD. Proves the full stack end-to-end in a browser — session, REST
 * through @talyn/client (so CORS + the client-version preflight), and the
 * WebSocket — and gives each panel a real URL. The forked panels replace the
 * body; the frame around them is what's being established here.
 */
export function Shell() {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const panel = panelForPath(location.pathname);

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.workspaces
      .list()
      .then((rows) => !cancelled && setWorkspaces(rows))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = wsClient.on<{ connected?: boolean }>('connection:status', (p) => {
      if (typeof p?.connected === 'boolean') setWsConnected(p.connected);
    });
    void wsClient.connect();
    return off;
  }, []);

  useEffect(() => {
    if (!workspaces?.length) return;
    for (const w of workspaces) wsClient.subscribe(w.id);
  }, [workspaces]);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border p-4">
        <span className="font-display text-lg font-semibold">Talyn</span>
        <nav className="mt-6 flex flex-col gap-1">
          {NAV.map(({ path, label }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm ${
                  isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto text-xs text-muted-foreground">
          <p className="truncate">{user?.email}</p>
          <button onClick={signOut} className="mt-2 underline hover:no-underline">
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 p-8">
        <h1 className="font-display text-xl font-semibold capitalize">
          {panel?.replace('_', ' ') ?? 'Talyn'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Panel not ported yet — this is the scaffold.
        </p>

        <dl className="mt-8 grid max-w-md gap-3 text-sm">
          <Row label="Backend (REST)">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : workspaces ? (
              `OK — ${workspaces.length} workspace(s)`
            ) : (
              'loading…'
            )}
          </Row>
          <Row label="WebSocket">{wsConnected ? 'connected' : 'connecting…'}</Row>
        </dl>
      </main>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border pb-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
