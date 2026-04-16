# FastOwl - Claude Context Document

> **IMPORTANT**: Read this entire file before starting any work on FastOwl.

## Git Workflow

**Repository**: `git@github.com:Gilbert09/owl.git` (main branch)

**After completing each task**, commit and push to GitHub:
1. Stage relevant changes: `git add <files>`
2. Commit with a descriptive message explaining what was done
3. Push to main: `git push origin main`

No branches or PRs needed - commit directly to main. Keep commits focused and atomic where possible.

## Overview

FastOwl is a desktop "mission control" application for AI-assisted software engineering. It orchestrates multiple Claude agents across different environments (local machine, VMs, dev containers), automates routine tasks, and provides a prioritized inbox of work needing human attention.

**Target User**: Software engineers who use AI assistants (Claude) heavily and work across multiple machines/environments simultaneously.

## Core Concepts

### Workspaces
A "workspace" groups related repositories and configuration together. For example, a "PostHog" workspace might include:
- `posthog/posthog` (main repo)
- `posthog/posthog.com` (website)
- `posthog/charts` (Helm charts)

Each workspace has its own integrations configured (GitHub org, Slack channels, PostHog project, etc.).

### Environments
An "environment" is a machine where work can be executed. Types include:
- **Local**: The user's own machine
- **SSH**: Remote machines accessible via SSH (e.g., `ssh vm1`)
- **Coder Devbox**: Coder.com managed workspaces (see `/Users/tomowers/dev/posthog/posthog/common/hogli/devbox/` for reference)
- **Future**: Dev containers, cloud VMs, etc.

### Agents
Claude instances running on an environment, executing tasks. Each agent:
- Has a status (idle, working, awaiting input, completed, errored)
- Has a visual "terminal" representation
- Can be color-coded based on attention needed (green = good, yellow = needs review, red = needs immediate attention)

### Tasks
Items of work that can be:
- **Manual**: Requires human action (e.g., "merge this PR", "reply to Slack message")
- **Automated**: Can be handled by an agent (e.g., "implement PR feedback", "check CI status")
- **Queued**: Waiting for an available agent
- **In Progress**: Being worked on by an agent

### Inbox
A prioritized list of items requiring human attention, including:
- Agent requests for input/decisions
- PR reviews received
- CI failures
- Slack mentions
- Completed work needing review

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron App (Frontend)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │  Inbox   │ │ Terminals│ │  Queue   │ │    Workspace     │    │
│  │  Panel   │ │  Panel   │ │  Panel   │ │    Settings      │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘    │
│                              │                                   │
│                     IPC (electron)                               │
└─────────────────────────────────────────────────────────────────┘
                               │
                    WebSocket/REST API
                               │
┌─────────────────────────────────────────────────────────────────┐
│                        Backend Server                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │  Agent   │ │ Environ- │ │   Task   │ │   Integration    │    │
│  │ Manager  │ │   ment   │ │  Queue   │ │     Manager      │    │
│  │          │ │ Manager  │ │          │ │ (GH,Slack,etc)   │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
         SSH/Coder          GitHub           Slack
         (Environments)     API              API
```

### Tech Stack

**Frontend (Electron)**:
- React 19 + TypeScript
- React Router for navigation
- TBD: State management (likely Zustand for simplicity)
- TBD: UI library (likely Tailwind + shadcn/ui for clean, minimal UI)
- xterm.js for terminal rendering

**Backend**:
- TypeScript (Node.js) - chosen over Python for consistency with frontend
- WebSocket for real-time communication
- SQLite for local persistence (workspaces, tasks, history)
- SSH2 library for environment connections

**IPC Communication**:
- Electron's contextBridge pattern (already set up in boilerplate)
- Typed channels for type safety

## Key Decisions Made

### Decision 1: TypeScript Backend (not Python)
**Date**: 2024-01-XX
**Rationale**:
- Single language across the stack reduces context switching
- Better integration with Electron ecosystem
- Shared types between frontend and backend
- Node.js has good SSH libraries (ssh2)

### Decision 2: Local-first Architecture
**Date**: 2024-01-XX
**Rationale**:
- No cloud dependency for core functionality
- Backend runs alongside Electron app on user's machine
- SQLite for persistence (portable, no setup)
- Can optionally connect to cloud services (GitHub, Slack, etc.)

### Decision 3: Environment-agnostic Agent Execution
**Date**: 2024-01-XX
**Rationale**:
- Start with simple SSH environments (user already has `ssh vm1`)
- Can add Coder integration later (reference implementation exists in PostHog)
- Can add dev containers later
- Abstract the "environment" concept so implementations can be swapped

### Decision 4: Use Claude CLI (not API directly)
**Date**: 2024-01-XX
**Rationale**:
- User already has Claude CLI set up on environments
- CLI handles authentication, context, etc.
- Provides the "terminal view" naturally
- Can capture output and detect when input is needed

## Resolved Questions

1. **Claude Integration**: Use Claude CLI on each environment (not direct API)
   - Natural terminal view
   - CLI handles auth
   - Parse output for status detection

2. **Authentication**: OAuth flows for GitHub/Slack/PostHog
   - Future-proofed for productionization
   - Better UX than manual token management

3. **Backend Architecture**: Deployable design, local-first development
   - Runs locally for development
   - Architected to be deployable to a hosted domain later
   - Multi-tenant ready for future productionization

4. **Implementation Order**: Terminal/agent orchestration first
   - Core unique value proposition
   - Layer integrations on top

---

## TODO List

> **Instructions**: Update this list as work progresses. Mark items as completed with `[x]`. Add new items as they're discovered.

### Phase 1: Foundation

- [x] **1.1 Project Structure Setup** (COMPLETED)
  - [x] Restructured to monorepo: `apps/desktop`, `packages/backend`, `packages/shared`
  - [x] Create backend directory with TypeScript + Node.js setup
  - [x] Create shared types package
  - [x] Add Tailwind CSS to renderer
  - [x] Add shadcn/ui with initial components (button, card, badge, scroll-area)
  - [x] Set up path aliases for clean imports
  - [x] Configure concurrent dev script (frontend + backend)

- [x] **1.2 Core Data Models & Types** (COMPLETED)
  - [x] Define `Workspace` type (id, name, repos[], integrations, settings)
  - [x] Define `Environment` type (id, name, type: local|ssh|coder, connection config, status)
  - [x] Define `Agent` type (id, environmentId, status, currentTask, terminal output)
  - [x] Define `Task` type (id, workspaceId, type: manual|automated, status, priority, assignedAgent)
  - [x] Define `InboxItem` type (id, type, source, priority, data, createdAt)
  - [x] Define WebSocket event types

- [x] **1.3 Database Layer** (COMPLETED)
  - [x] Set up SQLite with better-sqlite3
  - [x] Create migrations system
  - [x] Initial schema: workspaces, environments, tasks, inbox_items, settings, agents, repositories, integrations
  - [x] CRUD operations for each entity

- [x] **1.4 Backend Server** (COMPLETED)
  - [x] Express + WebSocket server setup
  - [x] REST endpoints for CRUD operations (workspaces, environments, tasks, agents, inbox)
  - [x] WebSocket events for real-time updates
  - [x] Health check endpoint
  - [x] Error handling middleware

- [x] **1.5 IPC & Communication Layer** (COMPLETED - using HTTP/WebSocket)
  - [ ] Extend Electron IPC channels (deferred - HTTP works for local)
  - [x] WebSocket client in renderer for backend communication
  - [x] Typed event system for real-time updates
  - [x] Connection state management (auto-reconnect, subscription management)

- [x] **1.6 Basic UI Shell** (COMPLETED)
  - [x] Main layout: sidebar + content area
  - [x] Workspace selector in sidebar
  - [x] Three-panel view: Inbox | Terminals | Queue
  - [x] Empty states for each panel
  - [x] Dark mode by default
  - [ ] Resizable panels (deferred)

### Phase 2: Environment Management

- [x] **2.1 SSH Connection Layer** (COMPLETED)
  - [x] SSH2 integration in backend
  - [x] Connection pooling
  - [x] Reconnection handling
  - [x] Connection status monitoring
  - [x] SSH key/agent auth support

- [x] **2.2 Environment Service** (COMPLETED)
  - [x] Add environment API
  - [x] Test connection
  - [x] Environment health checks (periodic ping)
  - [x] Remove environment
  - [x] Environment status events via WebSocket

- [x] **2.3 Environment UI** (COMPLETED - basic)
  - [x] "Add Environment" modal (with SSH config)
  - [x] Environment list in sidebar
  - [x] Connection status indicators (in sidebar)
  - [ ] Quick actions (connect, disconnect, remove)

- [x] **2.4 Local Environment** (COMPLETED)
  - [x] Local machine as default environment
  - [x] Spawn local processes
  - [x] PTY handling for local terminals

### Phase 3: Terminal & Agent System

- [x] **3.1 Terminal Infrastructure** (COMPLETED)
  - [x] xterm.js integration
  - [x] Terminal component with proper sizing (FitAddon)
  - [x] PTY over SSH (via ssh2 shell)
  - [x] Terminal multiplexing (multiple sessions per environment)
  - [ ] Terminal state persistence

- [x] **3.2 Terminal Panel UI** (COMPLETED)
  - [x] Agent list (terminal tabs)
  - [x] Terminal status indicators (color-coded)
  - [x] New agent button + modal
  - [x] Stop agent button (wired)
  - [ ] Close terminal button (needs wiring)
  - [ ] Terminal focus/maximize

- [x] **3.3 Claude Agent Service** (COMPLETED)
  - [x] Spawn `claude` CLI process on environment
  - [x] Stream stdout/stderr to terminal
  - [x] Parse Claude output for state detection:
    - Idle, Working, Awaiting input, Tool use, Completed, Error
  - [x] Send input to Claude process
  - [x] Agent lifecycle management (start, stop)

- [x] **3.4 Agent Status Detection** (COMPLETED)
  - [x] Regex patterns for Claude output parsing
  - [x] State machine for agent status
  - [x] "Needs attention" detection (questions, errors)
  - [x] Status change events via WebSocket

- [x] **3.5 Agent Panel UI** (COMPLETED)
  - [x] Agent cards showing current status
  - [x] Color-coded by attention needed
  - [x] Quick input for agent questions (wired to API)
  - [x] View full terminal button
  - [x] Start Agent modal with environment selection

### Phase 4: Task Queue System

- [x] **4.1 Task Service** (COMPLETED)
  - [x] Create task (manual or automated)
  - [x] Task prioritization algorithm
  - [ ] Task assignment to available agents
  - [ ] Task status transitions
  - [ ] Task history

- [x] **4.2 Queue Panel UI** (COMPLETED - basic)
  - [x] Task list grouped by status (queued, in progress, completed)
  - [x] Create task form (CreateTaskModal)
  - [x] Task details view
  - [ ] Drag-and-drop reordering
  - [x] Task actions (queue, unqueue, cancel) - wired to API

- [x] **4.3 Automated Task Runner** (COMPLETED)
  - [x] Watch for queued tasks
  - [x] Assign to idle agents
  - [x] Monitor task progress
  - [x] Handle task completion/failure
  - [ ] Retry logic

- [ ] **4.4 Task Templates**
  - [ ] Pre-defined task types (PR feedback, CI fix, etc.)
  - [ ] Template variables
  - [ ] Template UI

### Phase 5: Inbox System

- [x] **5.1 Inbox Service** (COMPLETED)
  - [x] Inbox item CRUD
  - [x] Priority calculation
  - [x] Mark as read/done
  - [x] Snooze functionality
  - [x] Inbox item sources (agents, integrations)

- [x] **5.2 Inbox Panel UI** (COMPLETED - basic)
  - [x] Inbox list sorted by priority
  - [x] Item type icons
  - [x] Quick actions per item type
  - [ ] Filter/search
  - [x] Bulk actions (API ready, UI needs wiring)

- [x] **5.3 Agent → Inbox Integration** (COMPLETED)
  - [x] Agent questions create inbox items
  - [x] Agent completions create review items
  - [x] Agent errors create attention items

### Phase 6: GitHub Integration

- [x] **6.1 GitHub OAuth** (COMPLETED)
  - [x] OAuth flow implementation (authorization URL, callback, code exchange)
  - [x] Token storage (in integrations table)
  - [ ] Token refresh (not needed for GitHub - tokens don't expire)
  - [x] Scope management (repo, read:user, read:org)

- [x] **6.2 GitHub Service** (COMPLETED - REST API)
  - [x] REST client setup (using fetch)
  - [x] List repositories
  - [x] PR queries (list, get single)
  - [x] CI status queries (check runs)
  - [x] PR comment creation
  - [ ] GraphQL client (deferred - REST sufficient for now)
  - [ ] Webhook handling (deferred)

- [ ] **6.3 PR Monitoring**
  - [ ] Watch configured repos for PR activity
  - [ ] New review comments → inbox
  - [ ] CI status changes → inbox (on failure)
  - [ ] PR merge ready → inbox

- [ ] **6.4 PR Actions**
  - [ ] View PR details
  - [ ] Create PR from agent work
  - [ ] Merge PR
  - [ ] Request changes

- [x] **6.5 GitHub UI** (COMPLETED - basic)
  - [x] Connect GitHub button (in Settings > Integrations)
  - [x] Connection status display (shows connected user)
  - [x] Disconnect button
  - [ ] Repository selector
  - [ ] PR list widget
  - [ ] CI status indicators

### Phase 7: Slack Integration

- [ ] **7.1 Slack OAuth**
  - [ ] OAuth flow implementation
  - [ ] Token storage
  - [ ] Workspace connection

- [ ] **7.2 Slack Service**
  - [ ] Slack Web API client
  - [ ] List channels
  - [ ] Message queries
  - [ ] Send messages
  - [ ] Real-time events (Socket Mode or webhooks)

- [ ] **7.3 Slack Monitoring**
  - [ ] Configure monitored channels
  - [ ] Direct mentions → inbox
  - [ ] Channel keywords → inbox

- [ ] **7.4 Slack Actions**
  - [ ] Reply to message
  - [ ] View thread
  - [ ] Open in Slack

- [ ] **7.5 Slack UI**
  - [ ] Connect Slack button
  - [ ] Channel selector
  - [ ] Message preview in inbox items

### Phase 8: PostHog Integration

- [ ] **8.1 PostHog Connection**
  - [ ] API key configuration
  - [ ] Project selection
  - [ ] Connection testing

- [ ] **8.2 PostHog Service**
  - [ ] Insights API queries
  - [ ] Events API queries
  - [ ] Alerts/annotations

- [ ] **8.3 Metrics Dashboard**
  - [ ] Key metrics widget
  - [ ] Configurable metrics
  - [ ] Trend indicators
  - [ ] Click-through to PostHog

- [ ] **8.4 PostHog Alerts**
  - [ ] Monitor for anomalies
  - [ ] Alert thresholds
  - [ ] Alerts → inbox

### Phase 9: Workspace Management

- [ ] **9.1 Workspace Service**
  - [ ] Create workspace
  - [ ] Configure repos
  - [ ] Configure integrations per workspace
  - [ ] Workspace switching

- [x] **9.2 Workspace UI** (COMPLETED - basic)
  - [x] Workspace settings panel (SettingsPanel with Workspace section)
  - [ ] Add/remove repos
  - [x] Integration toggles (UI ready, not wired to backend)
  - [ ] Workspace deletion

- [ ] **9.3 Multi-Workspace**
  - [ ] Workspace tabs/windows
  - [ ] Cross-workspace search
  - [ ] Workspace templates

### Phase 10: Intelligence & Automation

- [ ] **10.1 Context Analysis**
  - [ ] Parse repository structure
  - [ ] Identify common patterns
  - [ ] Extract project metadata

- [ ] **10.2 Smart TODOs**
  - [ ] Auto-suggest tasks from:
    - PR review comments
    - TODO comments in code
    - GitHub issues
    - Slack threads
  - [ ] Group related tasks
  - [ ] Priority suggestions

- [ ] **10.3 Automation Rules**
  - [ ] Rule definition (trigger → action)
  - [ ] Built-in rules:
    - PR review received → create task to address
    - CI failure → create task to fix
    - Slack mention → create inbox item
  - [ ] Custom rule builder
  - [ ] Rule UI

- [ ] **10.4 Background Planning**
  - [ ] Use Claude to plan work
  - [ ] Generate task breakdown
  - [ ] Estimate complexity
  - [ ] Suggest implementation order

### Backlog

- [x] **Change default ports** - Changed from 3001 to 4747 to avoid conflicts with common dev servers.
- [x] **Fix ESLint configuration** - Removed broken 'erb' extends, simplified config, fixed all lint errors.

### Phase 11: Settings & Configuration

- [ ] **11.1 Settings Service**
  - [ ] User preferences storage
  - [ ] Integration credentials (encrypted)
  - [ ] Default behaviors

- [x] **11.2 Settings UI** (COMPLETED - basic)
  - [x] Settings panel (SettingsPanel component)
  - [x] Sections: Workspace, Environments, Integrations (Appearance deferred)
  - [ ] Import/export settings

- [ ] **11.3 Keyboard Shortcuts**
  - [ ] Global shortcuts
  - [ ] Panel navigation
  - [ ] Quick actions
  - [ ] Customizable bindings

### Phase 12: Polish & Production

- [ ] **12.1 Notifications**
  - [ ] Desktop notifications
  - [ ] Notification preferences
  - [ ] Do not disturb mode

- [ ] **12.2 Onboarding**
  - [ ] First-run wizard
  - [ ] Environment setup guide
  - [ ] Integration connection flow

- [ ] **12.3 Error Handling**
  - [ ] Global error boundary
  - [ ] Error reporting
  - [ ] Recovery options

- [ ] **12.4 Performance**
  - [ ] Terminal virtualization
  - [ ] Database optimization
  - [ ] Memory management

- [ ] **12.5 Testing**
  - [ ] Unit tests for services
  - [ ] Integration tests
  - [ ] E2E tests

- [ ] **12.6 Documentation**
  - [ ] User guide
  - [ ] Developer docs
  - [ ] API documentation

- [ ] **12.7 Multi-Tenant Backend (Future)**
  - [ ] User authentication
  - [ ] Data isolation
  - [ ] API rate limiting
  - [ ] Deployment configuration

---

## File Structure (Actual)

```
fastowl/
├── apps/
│   └── desktop/                  # Electron desktop app
│       ├── src/
│       │   ├── main/             # Electron main process
│       │   │   ├── main.ts
│       │   │   └── preload.ts
│       │   └── renderer/         # React frontend
│       │       ├── index.tsx
│       │       ├── App.tsx
│       │       ├── App.css       # Tailwind + CSS variables
│       │       ├── components/
│       │       │   ├── layout/   # Sidebar, MainLayout
│       │       │   ├── modals/   # StartAgentModal, AddEnvironmentModal
│       │       │   ├── panels/   # InboxPanel, TerminalsPanel, QueuePanel
│       │       │   ├── terminal/ # XTerm component
│       │       │   └── ui/       # shadcn/ui components (Button, Card, Badge, Dialog, Input, Select, Textarea, ScrollArea)
│       │       ├── hooks/
│       │       ├── lib/          # Utils (cn, etc.)
│       │       └── stores/       # Zustand stores
│       ├── .erb/                 # Webpack configs
│       ├── assets/
│       ├── tailwind.config.js
│       ├── postcss.config.js
│       └── package.json
├── packages/
│   ├── backend/                  # Backend server
│   │   ├── src/
│   │   │   ├── index.ts          # Entry point
│   │   │   ├── db/               # SQLite + migrations
│   │   │   ├── routes/           # REST API routes
│   │   │   └── services/         # WebSocket, etc.
│   │   └── package.json
│   └── shared/                   # Shared types
│       ├── src/
│       │   └── index.ts          # All shared types
│       └── package.json
├── claude.md                     # This file
├── tsconfig.json                 # Root TS config
└── package.json                  # Workspace root
```

---

## Session Notes

### Session 1 (Initial)
- Created this document
- Explored Electron boilerplate structure
- Reviewed PostHog's Coder devbox implementation for reference
- Established architecture decisions
- Created initial TODO list

### Session 2 (Foundation + Backend Services)
- Restructured to monorepo: `apps/desktop`, `packages/backend`, `packages/shared`
- Created all core types in `@fastowl/shared`
- Built backend server with:
  - Express + WebSocket
  - SQLite database with migrations
  - REST API routes for all entities
  - WebSocket service for real-time events
- Added Tailwind CSS + PostCSS to renderer
- Created shadcn/ui style components (Button, Card, Badge, ScrollArea)
- Built UI shell with:
  - Sidebar with workspace selector, navigation, environment status
  - InboxPanel with prioritized items, actions, read/unread states
  - TerminalsPanel with agent list, terminal view, status indicators
  - QueuePanel with task list, detail view, priority badges
- Added Zustand store for app state management
- **SSH Service** (`packages/backend/src/services/ssh.ts`):
  - SSH connection management using ssh2 library
  - Connection pooling and auto-reconnection
  - PTY support for interactive terminal sessions
  - Command execution on remote environments
- **Environment Service** (`packages/backend/src/services/environment.ts`):
  - Manages local + SSH environments
  - Health checking
  - Interactive session spawning
- **Agent Service** (`packages/backend/src/services/agent.ts`):
  - Spawns Claude CLI processes on environments
  - Output parsing for status detection (working, awaiting_input, error, completed)
  - Auto-creates inbox items when agent needs attention
  - Agent lifecycle management
- **Task Queue Service** (`packages/backend/src/services/taskQueue.ts`):
  - Automatic task assignment to idle agents
  - Priority-based queue processing
  - Respects workspace maxConcurrentAgents setting
- **Frontend API Client** (`apps/desktop/src/renderer/lib/api.ts`):
  - HTTP client for all backend endpoints
  - WebSocket client with auto-reconnection
  - Real-time event handling
- **React Hooks** (`apps/desktop/src/renderer/hooks/useApi.ts`):
  - `useApiConnection` - WebSocket setup and event handling
  - `useInitialDataLoad` - Initial data fetch
  - `useAgentActions`, `useTaskActions`, `useInboxActions` - Action hooks
- App auto-detects backend availability; falls back to demo data if not running

### Session 3 (Terminal + Environment UI)
- Added xterm.js integration (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
- Created XTerm component (`apps/desktop/src/renderer/components/terminal/XTerm.tsx`):
  - Dark theme with proper VS Code-like colors
  - Auto-resize with FitAddon
  - Clickable links with WebLinksAddon
  - Efficient output appending (detects incremental updates)
- Created UI components:
  - Dialog, Input, Select, Textarea (`apps/desktop/src/renderer/components/ui/`)
  - StartAgentModal (`apps/desktop/src/renderer/components/modals/StartAgentModal.tsx`)
  - AddEnvironmentModal (`apps/desktop/src/renderer/components/modals/AddEnvironmentModal.tsx`)
- Updated TerminalsPanel to use:
  - XTerm for terminal rendering
  - StartAgentModal for creating new agents
  - Wired stop agent and send input functionality
- Updated Sidebar to show real environments from store with status indicators
- Added skipLibCheck to tsconfig for lucide-react compatibility

### Session 4 (Task Queue UI + Settings Panel + ESLint + Workspace Editing)
- Created CreateTaskModal (`apps/desktop/src/renderer/components/modals/CreateTaskModal.tsx`):
  - Form fields: title, description, type (automated/manual), priority
  - For automated tasks: agent prompt and preferred environment selection
  - Wired to useTaskActions hook and API
- Updated QueuePanel (`apps/desktop/src/renderer/components/panels/QueuePanel.tsx`):
  - Wired all "Add Task" buttons to open CreateTaskModal
  - Added task action buttons in TaskDetail: Queue, Unqueue, Cancel
  - Actions wired to useTaskActions hook (updateTaskStatus, cancelTask)
- Created SettingsPanel (`apps/desktop/src/renderer/components/panels/SettingsPanel.tsx`):
  - Three sections: Workspace, Integrations, Environments
  - Workspace section: shows name, description, automation settings, repos
  - Integrations section: GitHub, Slack, PostHog connection UI (not wired to backend)
  - Environments section: list environments, test connection, delete
- Updated store to support 'settings' as activePanel
- Wired Settings button in Sidebar footer
- **Fixed ESLint configuration**:
  - Removed broken 'erb' extends from root config
  - Simplified to use eslint:recommended + @typescript-eslint/recommended
  - Removed deprecated ESLint directives from main.ts, util.ts
  - Fixed all unused variable errors across desktop and backend
  - Added varsIgnorePattern and caughtErrorsIgnorePattern for underscore prefix
- **Wired workspace settings editing**:
  - Added useWorkspaceActions hook with updateCurrentWorkspaceSettings
  - Made auto-assign toggle and max agents select interactive in Settings
  - Backend correctly handles partial settings updates (merges with existing)
- Wired agent input sending to agentService in routes/agents.ts

### Session 5 (GitHub OAuth Integration)
- Created GitHub service (`packages/backend/src/services/github.ts`):
  - OAuth authorization URL generation with CSRF state
  - Code-to-token exchange
  - Token storage in integrations table
  - REST API methods: getUser, listRepositories, listPullRequests, getPullRequest, getCheckRuns, createPRComment
  - Auto-load tokens on service init
- Created GitHub routes (`packages/backend/src/routes/github.ts`):
  - GET /status - check configuration and connection status
  - POST /connect - start OAuth flow, return auth URL
  - GET /callback - handle OAuth callback, store token
  - POST /disconnect - remove token
  - GET /user - get authenticated user
  - GET /repos - list repositories
  - GET /repos/:owner/:repo/pulls - list PRs
  - GET /repos/:owner/:repo/pulls/:number/checks - get CI status
- Added GitHub API client to frontend (`apps/desktop/src/renderer/lib/api.ts`):
  - Type definitions for GitHubStatus, GitHubUser, GitHubRepo, GitHubPullRequest
  - Methods: getStatus, connect, disconnect, getUser, listRepos, listPullRequests
- Updated IntegrationsSettings in SettingsPanel:
  - Real-time status fetching from backend
  - Connect button opens OAuth in new window
  - Shows connected user (@username)
  - Disconnect button to remove connection
  - Proper error handling and loading states
- Configuration: Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI env vars

**Next Steps**:
- Create GitHub OAuth App and test the flow
- PR monitoring (watch repos, create inbox items)
- Repository selector UI in Settings
- Slack integration

---

## References

- PostHog Devbox Code: `/Users/tomowers/dev/posthog/posthog/common/hogli/devbox/`
- Electron React Boilerplate: https://github.com/electron-react-boilerplate/electron-react-boilerplate
- User's current VM setup: SSH accessible via `ssh vm1`
