import { useEffect, useState } from 'react';
import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { MainLayout } from './components/layout/MainLayout';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { LoginScreen } from './components/auth/LoginScreen';
import { useApiConnection, useInitialDataLoad } from './hooks/useApi';
import './App.css';

const API_BASE = process.env.FASTOWL_API_URL || 'http://localhost:4747';

async function checkBackend(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

function AuthedApp() {
  useApiConnection();
  useInitialDataLoad();
  return <MainLayout />;
}

function AppBody() {
  const { session, loading: authLoading } = useAuth();
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    checkBackend().then(setBackendAvailable);
  }, []);

  if (authLoading || backendAvailable === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-sm text-muted-foreground">Starting…</p>
        </div>
      </div>
    );
  }

  if (!backendAvailable) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="max-w-md text-center space-y-2">
          <p className="text-sm">Backend is unreachable.</p>
          <p className="text-xs text-muted-foreground">
            Expected at <code>{API_BASE}</code>. Start it with <code>npm run dev</code> in
            <code>packages/backend</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!session) return <LoginScreen />;
  return <AuthedApp />;
}

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/" element={<AppBody />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}
