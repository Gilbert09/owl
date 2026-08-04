import {
  Boxes,
  Bug,
  Disc3,
  Layers,
  ListChecks,
  Server,
  ScrollText,
  Siren,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { ROUTES, type RoutePath } from './routes';

/**
 * The console's navigation, as data.
 *
 * A single exported list rather than JSX in the sidebar, so a test can assert
 * that every destination is a real route (sidebarNav.test.tsx). Destinations
 * are typed `RoutePath`, so a link to a URL that does not exist is a `tsc`
 * error — the runtime test then covers what types cannot: that the route is
 * actually MOUNTED in App.tsx, not merely declared.
 */
export interface NavItem {
  id: string;
  label: string;
  to: RoutePath;
  icon: LucideIcon;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'fleet',
    label: 'Fleet',
    items: [
      { id: 'hosts', label: 'Hosts', to: ROUTES.fleetHosts, icon: Server },
      { id: 'runs', label: 'Runs', to: ROUTES.fleetRuns, icon: Boxes },
      { id: 'goldens', label: 'Goldens', to: ROUTES.fleetGoldens, icon: Disc3 },
      { id: 'incidents', label: 'Incidents', to: ROUTES.fleetIncidents, icon: Siren },
    ],
  },
  {
    id: 'product',
    label: 'Product',
    items: [
      { id: 'users', label: 'Users', to: ROUTES.users, icon: Users },
      { id: 'workspaces', label: 'Workspaces', to: ROUTES.workspaces, icon: Layers },
      { id: 'tasks', label: 'Tasks', to: ROUTES.tasks, icon: ListChecks },
    ],
  },
  {
    id: 'ops',
    label: 'Ops',
    items: [
      { id: 'audit', label: 'Audit log', to: ROUTES.audit, icon: ScrollText },
      { id: 'debug', label: 'Debug', to: ROUTES.debug, icon: Bug },
    ],
  },
];
