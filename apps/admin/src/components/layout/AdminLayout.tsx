import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Toaster } from '../ui/toaster';
import { useWsConnection } from '../../hooks/useWsConnection';

/**
 * The console shell. Only ever mounted behind AdminGate, which is why the
 * WebSocket connects here rather than at the app root — a non-operator should
 * not open a socket at all.
 */
export function AdminLayout() {
  useWsConnection();

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}
