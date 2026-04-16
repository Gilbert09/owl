import { useEffect, useState } from 'react';
import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { MainLayout } from './components/layout/MainLayout';
import { useWorkspaceStore } from './stores/workspace';
import { useApiConnection, useInitialDataLoad } from './hooks/useApi';
import './App.css';

// Check if backend is available
async function checkBackend(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:4747/health');
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

// Initialize with demo data when backend is not available
function useDemoData() {
  const {
    setWorkspaces,
    setCurrentWorkspace,
    setEnvironments,
    setAgents,
    setTasks,
    setInboxItems,
  } = useWorkspaceStore();

  useEffect(() => {
    const workspace = {
      id: '1',
      name: 'PostHog',
      description: 'PostHog development workspace',
      repos: [
        {
          id: '1',
          name: 'posthog/posthog',
          url: 'https://github.com/posthog/posthog',
          defaultBranch: 'master',
        },
      ],
      integrations: {},
      settings: {
        autoAssignTasks: true,
        maxConcurrentAgents: 3,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const environments = [
      {
        id: '1',
        name: 'Local',
        type: 'local' as const,
        status: 'connected' as const,
        config: { type: 'local' as const },
      },
      {
        id: '2',
        name: 'vm1',
        type: 'ssh' as const,
        status: 'connected' as const,
        config: {
          type: 'ssh' as const,
          host: 'vm1',
          port: 22,
          username: 'tom',
          authMethod: 'key' as const,
        },
      },
    ];

    const agents = [
      {
        id: '1',
        environmentId: '1',
        workspaceId: '1',
        status: 'working' as const,
        attention: 'none' as const,
        currentTaskId: '1',
        terminalOutput: `$ claude "Fix the authentication bug in login flow"

I'll help you fix the authentication bug. Let me first explore the codebase to understand the login flow.

> Reading src/auth/login.ts...
> Reading src/auth/session.ts...

I found the issue. The session token is not being properly validated after refresh. Here's my plan:

1. Update the validateToken function to check expiry
2. Add automatic token refresh before expiry
3. Handle edge cases for concurrent requests

Let me implement these changes...

> Editing src/auth/login.ts...`,
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: '2',
        environmentId: '2',
        workspaceId: '1',
        status: 'awaiting_input' as const,
        attention: 'high' as const,
        terminalOutput: `$ claude "Add rate limiting to API"

I've analyzed the API structure and have a question:

Should I implement rate limiting at:
1. The API gateway level (nginx/cloudflare)
2. The application level (middleware)
3. Both levels

Which approach would you prefer?`,
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ];

    const tasks = [
      {
        id: '1',
        workspaceId: '1',
        type: 'automated' as const,
        status: 'in_progress' as const,
        priority: 'high' as const,
        title: 'Fix authentication bug',
        description: 'Users are being logged out unexpectedly after token refresh',
        prompt: 'Fix the authentication bug in the login flow where users are logged out unexpectedly',
        assignedAgentId: '1',
        assignedEnvironmentId: '1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: '2',
        workspaceId: '1',
        type: 'automated' as const,
        status: 'queued' as const,
        priority: 'medium' as const,
        title: 'Add API rate limiting',
        description: 'Implement rate limiting to prevent abuse',
        prompt: 'Add rate limiting to the API endpoints',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: '3',
        workspaceId: '1',
        type: 'manual' as const,
        status: 'pending' as const,
        priority: 'low' as const,
        title: 'Update documentation',
        description: 'Update API docs with new endpoints',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const inboxItems = [
      {
        id: '1',
        workspaceId: '1',
        type: 'agent_question' as const,
        status: 'unread' as const,
        priority: 'high' as const,
        title: 'Agent needs input: Rate limiting approach',
        summary: 'Claude is asking whether to implement rate limiting at gateway or application level',
        source: { type: 'agent' as const, id: '2', name: 'Agent on vm1' },
        actions: [
          { id: '1', label: 'View & Respond', type: 'primary' as const, action: 'view_agent' },
        ],
        createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
      },
      {
        id: '2',
        workspaceId: '1',
        type: 'pr_review' as const,
        status: 'unread' as const,
        priority: 'medium' as const,
        title: 'PR #1234: Add feature flags',
        summary: 'Review requested by @teammate - 3 comments',
        source: { type: 'github' as const, name: 'posthog/posthog', url: 'https://github.com/posthog/posthog/pull/1234' },
        actions: [
          { id: '1', label: 'Review', type: 'primary' as const, action: 'open_pr' },
          { id: '2', label: 'Assign Claude', type: 'secondary' as const, action: 'assign_agent' },
        ],
        createdAt: new Date(Date.now() - 30 * 60000).toISOString(),
      },
      {
        id: '3',
        workspaceId: '1',
        type: 'slack_mention' as const,
        status: 'read' as const,
        priority: 'low' as const,
        title: '@tom mentioned in #engineering',
        summary: 'Can you take a look at the deployment issue?',
        source: { type: 'slack' as const, name: '#engineering' },
        actions: [
          { id: '1', label: 'Reply', type: 'primary' as const, action: 'open_slack' },
        ],
        createdAt: new Date(Date.now() - 2 * 3600000).toISOString(),
      },
    ];

    setWorkspaces([workspace]);
    setCurrentWorkspace('1');
    setEnvironments(environments);
    setAgents(agents);
    setTasks(tasks);
    setInboxItems(inboxItems);
  }, []);
}

function AppContent({ useBackend }: { useBackend: boolean }) {
  // Use API connection when backend is available
  if (useBackend) {
    useApiConnection();
    useInitialDataLoad();
  } else {
    useDemoData();
  }

  return <MainLayout />;
}

export default function App() {
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    checkBackend().then((available) => {
      setBackendAvailable(available);
      if (available) {
        console.log('Backend connected at http://localhost:4747');
      } else {
        console.log('Backend not available, using demo data');
      }
    });
  }, []);

  // Show loading while checking backend
  if (backendAvailable === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-sm text-muted-foreground">Connecting...</p>
        </div>
      </div>
    );
  }

  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={<AppContent useBackend={backendAvailable} />}
        />
      </Routes>
    </Router>
  );
}
