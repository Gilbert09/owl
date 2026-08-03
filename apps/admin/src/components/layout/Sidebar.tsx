import { NavLink } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { NAV_GROUPS } from '../../lib/nav';
import { APP_VERSION } from '../../lib/env';
import { useAuth } from '../auth/AuthProvider';
import { EnvironmentBadge } from './EnvironmentBadge';
import { cn } from '../../lib/utils';

/**
 * Written from scratch rather than forked from the product apps'.
 *
 * Theirs is ~70% WorkspaceSwitcher, cloud-provider status and PR-count badges
 * — all of which assume a current workspace, which this console does not have.
 *
 * Active state comes from `NavLink`, so the router owns it. That is what makes
 * the product apps' "clicked Merge Queue, landed on My PRs" class of bug
 * structurally impossible here: there is no second source of truth to race
 * against.
 */
export function Sidebar() {
  const { user, signOut } = useAuth();

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="space-y-2 px-4 pb-3 pt-4">
        <div className="font-display text-sm font-semibold tracking-tight">Talyn Admin</div>
        <EnvironmentBadge />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.id} className="mb-4">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={item.to}
                  data-attr={`nav-${item.id}`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    )
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="space-y-2 border-t border-border px-4 py-3">
        <div className="truncate text-xs text-muted-foreground" title={user?.email ?? undefined}>
          {user?.email ?? 'Signed in'}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[10px] text-muted-foreground/70">
            {APP_VERSION}
          </span>
          <button
            onClick={() => void signOut()}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
