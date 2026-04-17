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

Each workspace has:
- Configured integrations (GitHub org, Slack channels, PostHog project, etc.)
- Repository paths on each environment (for spawning Claude in the right directory)
- Auto-clone settings (FastOwl can clone repos on environments when setting up workspace)

### Environments
An "environment" is a machine where work can be executed. Types include:
- **Local**: The user's own machine
- **SSH**: Remote machines accessible via SSH (e.g., `ssh vm1`)
- **Coder Devbox**: Coder.com managed workspaces
- **Future**: Dev containers, cloud VMs, etc.

**Git user**: FastOwl uses the machine's configured git user (your personal GitHub account on local, same on VM, etc.). No special configuration needed.

### Tasks
Tasks are the primary unit of work in FastOwl. They represent anything that needs to be done:

**Task Types**:
- **Code Writing**: Build a feature, fix a bug, refactor code (creates git branch)
- **PR Response**: Automated - review comments on your PR, implement changes, wait for approval before pushing
- **PR Review**: Suggest review comments on someone else's PR
- **Manual**: Requires human action (merge PR, reply to Slack)

**Task Lifecycle**:
- **Pending**: Created but not yet started
- **Queued**: Waiting for an available environment slot
- **In Progress**: Claude is actively working (or paused awaiting input)
- **Awaiting Approval**: Work is done, waiting for user to approve before pushing
- **Completed**: Work is done and pushed/merged

**Key Design Principles**:
1. **Tasks own agents** - Users create/manage tasks, not agents. Agents are internal.
2. **Approval gates** - Automated tasks do work, then wait for approval before pushing changes to the world
3. **One active task per repo per environment** - Git branch isolation
4. **Session persistence** - Task history and conversation persists, sessions can be paused/resumed

### Git Branch Management (Code-Writing Tasks)
Each code-writing task:
- Gets assigned a dedicated git branch (e.g., `fastowl/task-123-fix-auth-bug`)
- All work happens on that branch
- Before another task runs on the same repo, current work is committed/stashed
- Resuming a task auto-checks out the correct branch
- User approves before merging/pushing to main

### Interactive Terminal
The task terminal provides a full Claude CLI-like experience:
- Real-time streaming output
- Interactive conversation with Claude
- **Native UI overlays** for common actions:
  - Selecting options from choices Claude presents
  - Giving feedback on proposed changes
  - Accepting/rejecting permission requests
  - One-click approval/rejection buttons
- Full history persistence and replay

### Inbox
A prioritized list of items requiring human attention:
- Tasks awaiting approval (work done, ready to push)
- Tasks awaiting input (Claude asked a question)
- PR reviews received
- CI failures
- Slack mentions
- Completed work needing review

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron App (Frontend)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │  Inbox   │ │  Tasks   │ │  GitHub  │ │    Settings      │    │
│  │  Panel   │ │  Panel   │ │  Panel   │ │                  │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘    │
│                              │                                   │
│   Tasks Panel shows: task list + terminal view for running tasks │
│                     IPC (electron)                               │
└─────────────────────────────────────────────────────────────────┘
                               │
                    WebSocket/REST API
                               │
┌─────────────────────────────────────────────────────────────────┐
│                        Backend Server                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │  Agent   │ │ Environ- │ │   Task   │ │   Integration    │    │
│  │ Service  │ │   ment   │ │  Queue   │ │     Manager      │    │
│  │(internal)│ │ Manager  │ │          │ │ (GH,Slack,etc)   │    │
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

### Decision 5: Tasks Own Agents (not user-facing agents)
**Date**: 2024-04-XX
**Rationale**:
- Cleaner conceptual model: users think in terms of tasks, not agents
- Each task has its own Claude agent spawned when it starts
- Terminal output is part of the task, not a separate view
- Simpler UI: removed separate Terminals panel
- Tasks Panel shows both queue and live terminal for running tasks
- Per-environment concurrency is maintained (one running task per environment)

### Decision 6: Git-Centric Task Workflow
**Date**: 2024-04-XX
**Rationale**:
- Code-writing tasks each get a dedicated git branch
- Provides isolation and easy rollback
- Enables pausing/resuming tasks (stash/checkout)
- One active task per repo per environment prevents conflicts
- User approves before pushing - no surprise changes in the world

### Decision 7: Approval-Based Automation
**Date**: 2024-04-XX
**Rationale**:
- Automated tasks should do work, then wait for user approval before pushing
- This gives users control while still automating the grunt work
- Different task types have different approval requirements:
  - PR Response: do work → show diff → wait for approval → push
  - Feature Build: work in progress → await input as needed → user marks complete
  - PR Review: suggest comments → wait for approval → post comments

### Decision 8: Reference Architecture - PostHog Code
**Date**: 2024-04-XX
**Reference**: https://github.com/PostHog/code
**Key patterns to adopt**:
- Session persistence via conversation log replay (`resumeFromLog()`)
- TreeTracker for git working tree snapshots
- Permission modes (default, acceptEdits, plan, bypassPermissions)
- tRPC over Electron IPC for type-safe communication
- Zustand stores for UI state, services for business logic
- Saga pattern for atomic operations with rollback

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

- [x] **3.2 Terminal Panel UI** (REFACTORED - merged into Tasks Panel)
  - [x] ~~Agent list (terminal tabs)~~ - Removed, tasks list replaces this
  - [x] Terminal status indicators (color-coded) - Now on task cards
  - [x] ~~New agent button + modal~~ - Removed, tasks spawn their own agents
  - [x] Stop button - Now on running tasks
  - [x] Terminal view - Now embedded in TaskDetail when task is running

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

- [x] **3.5 Agent Panel UI** (REFACTORED - agents are internal, UI moved to Tasks)
  - [x] ~~Agent cards~~ - Task cards now show agent status when running
  - [x] Color-coded by attention needed - On task cards
  - [x] Quick input for questions - In TaskTerminal component
  - [x] ~~Start Agent modal~~ - Removed, "Start Task" button starts agents
  - [x] TaskTerminal component - Shows terminal when task is in_progress

### Phase 4: Task Queue System

- [x] **4.1 Task Service** (COMPLETED)
  - [x] Create task (manual or automated)
  - [x] Task prioritization algorithm
  - [ ] Task assignment to available agents
  - [ ] Task status transitions
  - [ ] Task history

- [x] **4.2 Queue Panel UI** (COMPLETED - now primary view)
  - [x] Task list grouped by status (queued, in progress, completed)
  - [x] Create task form (CreateTaskModal)
  - [x] Task details view with terminal when running
  - [ ] Drag-and-drop reordering
  - [x] Task actions: queue, unqueue, cancel, start, stop, send input
  - [x] TaskTerminal component for running tasks
  - [x] Agent status indicators on task cards

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

- [x] **6.3 PR Monitoring** (COMPLETED)
  - [x] Watch configured repos for PR activity (polling every 60s)
  - [x] New review comments → inbox
  - [x] CI status changes → inbox (on failure)
  - [x] PR merge ready → inbox

- [x] **6.4 PR Actions** (COMPLETED)
  - [x] View PR details (PRDetailModal with files, checks, branches)
  - [x] Create PR from agent work (API endpoint ready)
  - [x] Merge PR (with merge/squash/rebase options)
  - [x] Approve/Request changes (review submission)

- [x] **6.5 GitHub UI** (COMPLETED)
  - [x] Connect GitHub button (in Settings > Integrations)
  - [x] Connection status display (shows connected user)
  - [x] Disconnect button
  - [x] Repository selector (in Settings > Workspace > Watched Repositories)
  - [x] PR list widget (PRListWidget with checks status)
  - [x] CI status indicators (check status icons in PR list)
  - [x] Dedicated GitHub panel in sidebar

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

- [x] **9.1 Workspace Service** (COMPLETED - basic)
  - [x] Create workspace (`routes/workspaces.ts` + `useWorkspaceActions`)
  - [x] Configure repos (`routes/repositories.ts` + Settings panel)
  - [x] Configure integrations per workspace (integrations table + Settings panel)
  - [x] Workspace switching (Sidebar workspace selector + store)
  - [ ] Multi-workspace tabs (deferred to 9.3)

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

### Known Gaps (tracked but not yet phased)

- **Backend bundling for release**: `npm run package` bundles `apps/desktop` only. The backend is not shipped with the Electron artifact today — users running a packaged build would have no backend unless they run `@fastowl/backend` separately. Needs a Phase 12 sub-item.
- **Credential encryption at rest**: GitHub OAuth tokens and other integration tokens live in SQLite as plaintext (Phase 11.1 subitem).
- **Backend-down UX**: Frontend assumes the backend is reachable at `localhost:4747`. No graceful offline/reconnect indicator beyond the WebSocket auto-reconnect loop.
- **Testing**: Only one smoke test (`apps/desktop/src/__tests__/App.test.tsx`). Full plan in `docs/TESTING.md`. Tracked under Phase 12.5.
- **Release packaging**: CI `publish.yml` builds desktop only on tag push — doesn't build the backend.
- **MacOS notarization**: `afterSign: .erb/scripts/notarize.js` is wired up but untested in the fastowl repo specifically.
- **Multi-step agent state recovery**: A task agent crashing mid-run loses its state (the task does persist, and recovery resets to `queued` via `recoverStuckTasks`, but no partial resume).

### Priority Queue (Next Up)
> These are the immediate priorities based on user feedback:

1. ~~**Phase 13.3 - Smart Task Creation** (Quick win)~~ DONE
   - ~~Remove required name/description, auto-generate with Haiku~~

2. ~~**Phase 13.4 - Repository Context** (Essential)~~ DONE
   - ~~Spawn Claude in correct repo directory~~

3. ~~**Phase 14.1-14.2 - Git Branch Management** (Core feature)~~ DONE
   - ~~Task branches~~ - Auto-create branch when starting task with repo

4. ~~**Phase 12.8 - Light Mode** (Quick win)~~ DONE
   - ~~Theme toggle, system detection~~

5. ~~**Phase 15.1-15.3 - Task History** (Important UX)~~ DONE (raw terminal output persisted + shown for completed tasks; structured log deferred)

6. ~~**Phase 13.1 - Interactive Terminal** (Core feature)~~ DONE
   - ~~Full interactivity, bidirectional communication~~

7. **Phase 13.2 - Native UI Overlays** (Enhanced UX)
   - Clickable options, approval buttons on Claude TUI

9. **Phase 16.3 - Automated PR Response** (Core workflow)
   - Hook PR monitor → auto-create `pr_response` tasks on new review comments

10. **Phase 12.5 - Testing framework** (Reliability)
    - See `docs/TESTING.md` for the full plan. Start with backend service tests + a handful of E2E smoke flows.

11. **Phase 18 - Hosted backend + local daemon** (Shipping / productionization)
    - Split backend into hosted server + local daemon; migrate from SQLite to Supabase Postgres; see Phase 18 below.

8. ~~**Phase 16.1/16.2/16.5 - Approval Workflows** (Core feature)~~ DONE (task types, awaiting_review gate, approve/reject). Remaining: 16.3 PR Response auto-trigger, 16.4 PR Review batch-post, diff preview.

### Phase 11: Settings & Configuration

- [ ] **11.1 Settings Service** (PARTIALLY COMPLETED)
  - [x] Workspace-scoped preferences (autoAssignTasks, maxConcurrentAgents)
  - [x] Integration credentials storage (integrations table - plaintext currently)
  - [ ] Encrypt integration credentials at rest
  - [ ] Top-level user preferences (theme is in localStorage, no user-level store)
  - [ ] Default behaviors per task type

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

- [ ] **12.5 Testing** (IN PROGRESS - Phase A + B landed)
  - See [`docs/TESTING.md`](./docs/TESTING.md) for the full plan (stack, layers, CI wiring, rollout)
  - [x] Phase A: Vitest on backend; desktop Jest setup fixed for headless CI (matchMedia polyfill, dropped build-exists guard)
  - [x] Phase B: Backend service tests — migrations (6), status detection (10), gitService (8), taskQueue (8). 32 passing; fake-environment harness at `src/__tests__/helpers/fakeEnvironment.ts` usable by any service that touches environments.
  - [ ] Phase B cont'd: agentService integration tests (lifecycle, inbox item creation), prMonitor tests, ai service tests
  - [ ] Phase C: Backend route tests via supertest (tasks, repositories, workspaces, github, inbox routes)
  - [ ] Phase D: Frontend hook tests (useTaskActions, useApiConnection) and component tests (TerminalHistory, TaskDiff)
  - [ ] Phase E: Playwright E2E for 5 golden flows

- [ ] **12.6 Documentation**
  - [ ] User guide
  - [ ] Developer docs
  - [ ] API documentation

- [ ] **12.7 Multi-Tenant Backend (Future)**
  - [ ] User authentication
  - [ ] Data isolation
  - [ ] API rate limiting
  - [ ] Deployment configuration

- [x] **12.8 Appearance** (COMPLETED)
  - [x] Light mode theme
  - [x] Theme toggle in settings (Appearance section)
  - [x] System theme detection (auto)
  - [x] Persist theme preference (localStorage)

### Phase 13: Enhanced Terminal Interaction
> Reference: https://github.com/PostHog/code for patterns

- [x] **13.1 Interactive Claude Terminal** (COMPLETED)
  - [x] Full interactive mode (not just --print)
  - [x] Bidirectional communication with Claude CLI
  - [x] Continue conversation after task starts
  - [x] Terminal stays active for follow-up questions
  - [x] Always-visible input field for sending messages

- [ ] **13.2 Native UI Overlays**
  - [ ] Detect when Claude presents options (numbered choices)
  - [ ] Render clickable buttons for options
  - [ ] One-click approval/rejection for proposed changes
  - [ ] Permission request UI (accept/reject tool use)
  - [ ] Feedback input with quick templates

- [x] **13.3 Smart Task Creation** (COMPLETED)
  - [x] Remove required name/description fields (prompt-first for automated tasks)
  - [x] Auto-generate task name from prompt (Haiku LLM call via AI service)
  - [x] Show generating indicator while creating
  - [x] Allow editing generated name (in collapsed section)

- [x] **13.4 Repository Context** (COMPLETED)
  - [x] Repository selector in CreateTaskModal
  - [x] Spawn Claude in correct repo directory for task (via workingDirectory)
  - [x] Support multiple repos per workspace
  - [ ] Auto-clone repos on environment setup (optional) - deferred

### Phase 14: Git-Centric Workflow

- [x] **14.1 Task Branch Management** (COMPLETED)
  - [x] Auto-create branch when code-writing task starts (`fastowl/{id}-{slug}`)
  - [x] Track branch per task in database
  - [x] Auto-checkout branch when resuming task
  - [ ] One active task per repo per environment (deferred)

- [x] **14.2 Work State Preservation** (PARTIALLY COMPLETED)
  - [ ] Before starting new task: commit/stash current work
  - [x] Detect uncommitted changes (gitService.hasUncommittedChanges)
  - [ ] Prompt user or auto-stash with task reference
  - [x] Stash utility available (gitService.stashChanges)

- [ ] **14.3 Branch Lifecycle**
  - [ ] Delete branch after task merged/completed
  - [ ] Option to keep branches for reference
  - [ ] List task branches in UI
  - [ ] Push branch to remote for backup

- [ ] **14.4 PR Creation from Task**
  - [ ] "Create PR" button on completed tasks
  - [ ] Pre-fill PR title/description from task
  - [ ] Select target branch (main/master)
  - [ ] Link PR to task in UI

### Phase 15: Session Persistence & History

- [x] **15.1 Conversation Logging** (COMPLETED - raw terminal output)
  - [x] Persist all terminal output to task record (tasks.terminal_output column, append-only)
  - [ ] Store structured conversation (user messages, agent responses, tool calls) - deferred
  - [ ] Persist agent state snapshots - deferred
  - [ ] ndJson format for efficient append - chose plain-text column for simplicity; revisit if structured replay is needed

- [ ] **15.2 Session Resume**
  - [ ] Reconstruct conversation state from logs
  - [ ] Resume Claude session with context (if Claude CLI supports)
  - [ ] Fallback: start new session with conversation summary
  - [ ] "Continue where I left off" functionality

- [x] **15.3 Task History UI** (COMPLETED - basic)
  - [x] View full conversation history for any task (TerminalHistory component in TaskDetail)
  - [x] Scroll through past terminal output (XTerm in read-only mode)
  - [x] Collapsible section (expand/collapse toggle)
  - [ ] Collapsible tool use sections (requires structured log - deferred)
  - [ ] Search within task history - deferred

- [ ] **15.4 Agent Reuse (Investigate)**
  - [ ] Research: Can Claude CLI sessions be paused/frozen?
  - [ ] Research: MCP session persistence capabilities
  - [ ] If possible: implement session serialization
  - [ ] If not: implement context summarization for new sessions

### Phase 16: Task Types & Approval Workflows

- [x] **16.1 Task Type System** (COMPLETED)
  - [x] Define task types: code_writing, pr_response, pr_review, manual (TaskType union in shared)
  - [x] Type-specific behaviors (isAgentTask helper; queue auto-processes anything !== 'manual')
  - [x] Type icons in CreateTaskModal and QueuePanel (Sparkles/MessageSquare/Eye/Hand)
  - [x] Type-specific prompt placeholders in CreateTaskModal
  - [ ] Type-specific default prompts/templates (deferred - just placeholders for now)
  - [x] Migration 005 renames existing 'automated' → 'code_writing'

- [x] **16.2 Approval Gates** (COMPLETED - basic)
  - [x] "Awaiting Review" status routed through (existing `awaiting_review` TaskStatus)
  - [x] Approve/Reject buttons in TaskDetail for awaiting_review tasks
  - [x] "Ready for Review" button in TaskTerminal stops agent + transitions to awaiting_review
  - [x] Agent session close (code === 0) now routes agent tasks to awaiting_review instead of completed
  - [x] Reject sends task back to queued for another pass
  - [x] Show diff of changes before approve (`gitService.getDiff` + `GET /tasks/:id/diff` + `TaskDiff` component with +/- colored lines)
  - [ ] Comments on approval (deferred)
  - [ ] Push only after approval (push automation deferred; currently user still handles push)

- [ ] **16.3 PR Response Task Type**
  - [ ] Triggered by PR comment notifications
  - [ ] Auto-checkout PR branch
  - [ ] Review comments and implement changes
  - [ ] Wait for approval before pushing
  - [ ] Auto-create if configured in automation rules

- [ ] **16.4 PR Review Task Type**
  - [ ] Review someone else's PR
  - [ ] Suggest review comments (not post immediately)
  - [ ] Show suggested comments in UI
  - [ ] User approves which comments to post
  - [ ] Batch post approved comments

- [x] **16.5 Task Completion Model** (COMPLETED)
  - [x] Agent tasks: complete only after user approval (approve button in awaiting_review)
  - [x] Status flow: in_progress → awaiting_review → completed/queued (rejected)
  - [ ] Manual-task completion UX (still uses generic status picker - minor polish)

### Phase 17: Automation & Triggers

- [ ] **17.1 Automation Rules (Enhanced)**
  - [ ] PR comment on my PR → create PR Response task
  - [ ] CI failure → create fix task
  - [ ] New PR for review → create PR Review task (optional)
  - [ ] Configure per workspace

- [ ] **17.2 Auto-Start Behavior**
  - [ ] Option to auto-start triggered tasks
  - [ ] Option to just create inbox item for manual start
  - [ ] Rate limiting (max concurrent auto-tasks)

- [ ] **17.3 Notification Preferences**
  - [ ] Per-task-type notification settings
  - [ ] Desktop notifications for approval requests
  - [ ] Digest mode (batch notifications)

### Phase 18: Hosted Backend + Local Daemon

> **Goal**: move from local-only SQLite backend to a hosted control plane (Supabase Postgres + containerized Node server) with a local daemon on the user's machine that handles environment/agent execution. Preserves local-first execution while enabling cross-device state, multi-user auth, and proper productionization.
>
> **Reference architecture**: hosted server owns state + integrations; local daemon owns SSH/PTY/Claude CLI execution; they communicate via an authenticated outbound WebSocket tunnel from the daemon to the server.

- [ ] **18.1 DB abstraction + Postgres/Supabase migration**
  - [ ] Pick a TypeScript ORM with migration tooling - **recommended: Drizzle ORM + drizzle-kit** (TS-first, schema-driven migrations, Supabase-compatible)
  - [ ] Define schema in Drizzle, translate existing `db/index.ts` migrations (001-005) into Drizzle migration files
  - [ ] Introduce a `DatabaseClient` interface so routes/services don't depend on `better-sqlite3` directly
  - [ ] Add Supabase project + wire `DATABASE_URL` env var
  - [ ] `npm run db:migrate` script (drizzle-kit migrate); `npm run db:generate` for new migrations
  - [ ] Keep SQLite as the local-mode default (single-user path) during transition

- [ ] **18.2 Auth + multi-tenancy**
  - [ ] Supabase Auth with GitHub OAuth (reuses existing GitHub integration)
  - [ ] Add `user_id` column on workspaces, environments, tasks, inbox_items, integrations, repositories
  - [ ] Enforce user scoping in every route handler (Supabase RLS policies + server-side checks)
  - [ ] Login UI in desktop app (sign in with GitHub → receive JWT → store in secure local storage)
  - [ ] Auth middleware on Express routes + WebSocket upgrade

- [ ] **18.3 Split backend into server + daemon**
  - [ ] New `packages/server` — hosted control plane: routes, DB, auth, GitHub integration, PR monitor, inbox. No ssh2/node-pty.
  - [ ] New `packages/daemon` — local execution: extracted environment/agent/git services + outbound WS client that connects to the hosted server
  - [ ] Wire protocol: server → daemon commands (spawn agent, send input, stop, git ops); daemon → server events (terminal output, status changes)
  - [ ] Daemon auth: device-scoped token minted by server on first link
  - [ ] **Bundled daemon**: child process of the Electron app for the user's own machine (simplest UX, ships with the app)
  - [ ] **Deployable daemon**: `fastowl-daemon` as a standalone binary/CLI distributable to VMs
    - [ ] Single-file binary (pkg, bun --compile, or Docker image)
    - [ ] Systemd unit / launchd plist for auto-start
    - [ ] Self-register with hosted server on first run using a one-time pairing token from the desktop app
  - [ ] **Remote install flow**: given SSH creds for a VM, FastOwl installs the daemon automatically
    - [ ] Desktop UI: "Add SSH environment" → inline option "Install daemon on this host"
    - [ ] Backend provisioning: SSH in, detect arch/OS, `curl | sh` the daemon binary, write config with pairing token, start under systemd/launchd
    - [ ] Health check: confirm daemon connects back to hosted server before marking env ready
    - [ ] Uninstall flow: symmetric — remove env in UI optionally tears down daemon on VM

- [ ] **18.4 Deployment**
  - [ ] Dockerfile for `packages/server` (Node 22, slim base)
  - [ ] **Hosting: Fly.io** (recommended — persistent volumes, WS-friendly, cheap; alternatives: Railway, Render)
  - [ ] `fly.toml` config + secrets (DATABASE_URL, SUPABASE_*, ANTHROPIC_API_KEY, GITHUB_CLIENT_SECRET)
  - [ ] Health check endpoint for Fly's load balancer
  - [ ] Rate limiting on public API (per-user)

- [ ] **18.5 CI for hosted backend**
  - [ ] `.github/workflows/deploy-backend.yml` — on push to `main`, run migrations (`drizzle-kit migrate`) + `flyctl deploy`
  - [ ] Separate staging vs production environments
  - [ ] Automated Supabase branch creation for PR previews (optional, nice-to-have)
  - [ ] Rollback procedure documented

- [ ] **18.6 Desktop app integration**
  - [ ] Replace hardcoded `http://localhost:4747` with configurable server URL (env-specific: `fastowl.dev` prod, localhost for self-hosted/dev)
  - [ ] First-run flow: choose "Cloud (hosted)" vs "Self-hosted/local" mode
  - [ ] Graceful degradation when daemon is offline (show state but disable execution)
  - [ ] Encrypt stored JWT at rest via OS keychain (Electron safeStorage API)

- [ ] **18.7 Data migration for existing users**
  - [ ] One-click "Sync to cloud" flow reads local SQLite and pushes to hosted Postgres
  - [ ] Preserve task history, inbox items, workspace config

- [ ] **18.8 Observability — PostHog**
  - PostHog is the single product analytics + error tracking + logs platform for FastOwl; no separate Sentry/Datadog/etc.
  - [ ] Structured logging on server (pino), shipped to PostHog via log-to-events
  - [ ] Error tracking via PostHog error tracking (server + daemon + Electron renderer + main process)
  - [ ] Product analytics events: task created, task approved/rejected, env added, integration connected, time-to-first-agent
  - [ ] PostHog session replay for desktop UX debugging (opt-in only)
  - [ ] Fly.io platform metrics → PostHog (CPU/mem/request counts) via webhook or periodic push
  - [ ] Dashboards: cohort retention, error rate by route, approval latency histogram
  - [ ] Self-host PostHog or PostHog Cloud — defer decision; cloud is faster to start

### Phase 19: Developer Tooling

> Tools that speed up the dev loop. Add/maintain as we go.

- [ ] **19.1 MCP servers for Claude Code**
  - [ ] **GitHub MCP** (`@modelcontextprotocol/server-github`) — lets Claude query repo state, PRs, issues, runs without one-off gh commands. High value once PR automation work starts.
  - [ ] **Supabase MCP** (`@supabase/mcp-server-supabase`) — query hosted DB schema and rows during dev without leaving the editor. Critical once 18.1 lands.
  - [ ] **PostHog MCP** — query analytics/errors from the editor; great for "what broke in the last hour" during incidents. Once 18.8 is live.
  - [ ] **Filesystem MCP** (optional) — scoped to the repo root; usually not needed since Claude Code already has file tools
  - [ ] Document the MCP setup in [`docs/SETUP.md`](./docs/SETUP.md) so any contributor can wire them up in one go

- [ ] **19.2 Scripts + DX polish**
  - [ ] `npm run db:reset` — drop the local SQLite DB and recreate via migrations (safer than manual `rm ~/.fastowl/fastowl.db`)
  - [ ] `npm run db:seed` — optional seed data for demo purposes (sample workspace, mocked tasks for UI development)
  - [ ] `npm run logs` — tail backend + desktop main-process logs in one stream
  - [ ] Pre-commit hook (husky + lint-staged) for typecheck + eslint on changed files only

- [ ] **19.3 Local `claude` CLI smoke harness**
  - [ ] Fixture transcripts + a test harness that replays them into `agent.analyzeOutput()` to catch regressions in status detection when the Claude CLI output format changes

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
│       │       │   ├── modals/   # AddEnvironmentModal, CreateTaskModal, PRDetailModal
│       │       │   ├── panels/   # InboxPanel, QueuePanel, TaskTerminal, GitHubPanel, SettingsPanel
│       │       │   ├── terminal/ # XTerm component
│       │       │   ├── widgets/  # PRListWidget
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
- PR Actions (view PR details, create PR)
- Slack integration

### Session 9 (Approval Gates — Phase 16.2 + 16.5)
- **Backend agent close** (`packages/backend/src/services/agent.ts`):
  - Clean exit (code 0) now sets task to `awaiting_review` instead of `completed` (no `completed_at`)
  - Non-zero exit still sets task to `failed`
  - Emits `task:status` WS event for the transition
- **New routes** (`packages/backend/src/routes/tasks.ts`):
  - `POST /tasks/:id/ready-for-review` - stops agent, moves task to awaiting_review (agent tasks only)
  - `POST /tasks/:id/approve` - awaiting_review → completed
  - `POST /tasks/:id/reject` - awaiting_review → queued for another pass
- **Frontend API + hooks** (`apps/desktop/src/renderer/lib/api.ts`, `apps/desktop/src/renderer/hooks/useApi.ts`):
  - `api.tasks.readyForReview/approve/reject` client methods
  - `readyForReview/approveTask/rejectTask` in `useTaskActions`
- **UI**:
  - `TaskTerminal` now has a primary "Ready for Review" button alongside "Stop" (stop = discard; ready = approval flow)
  - `QueuePanel` TaskDetail shows "Approve" and "Reject & Requeue" buttons when `task.status === 'awaiting_review'`

**Deferred**: git diff preview in the approval view, approval comments, push-after-approve automation, automated PR response triggering (16.3), PR review batch-post flow (16.4).

### Session 8 (Task Type System — Phase 16.1)
- **Shared types** (`packages/shared/src/index.ts`):
  - `TaskType` expanded to `'code_writing' | 'pr_response' | 'pr_review' | 'manual'`
  - Added `AGENT_TASK_TYPES` constant and `isAgentTask(type)` helper
- **Migration 005** (`packages/backend/src/db/index.ts`):
  - `UPDATE tasks SET type = 'code_writing' WHERE type = 'automated'`
- **Task queue + routes** (`packages/backend/src/services/taskQueue.ts`, `packages/backend/src/routes/tasks.ts`):
  - Auto-processing check switched from `type === 'automated'` to `isAgentTask(type)` (any non-manual)
  - `/tasks/:id/start` now accepts any agent task type
- **CreateTaskModal**:
  - 4-button type picker (Code / PR Response / PR Review / Manual) with icons
  - Type-specific prompt placeholder and description
  - Switches between prompt-first (agent) and title-first (manual) layouts via `isAgentTask`
- **QueuePanel**:
  - `taskTypeConfig` renders type-specific icon + label in task list items and detail view
  - Replaced `isAutomated` check with `isAgentTask(task.type)` for "Start Now" button gating

**Deferred for 16.2-16.5**: approval gates (awaiting_review status), diff preview, automated PR Response triggering, PR Review batch-post flow, type-specific default prompt templates.

### Session 7 (Task Terminal History Persistence)
- **Migration 004** (`packages/backend/src/db/index.ts`):
  - Added `terminal_output TEXT NOT NULL DEFAULT ''` column to `tasks` table
- **Append-only task output** (`packages/backend/src/services/agent.ts`):
  - `handleSessionData` now appends incoming chunks to `tasks.terminal_output` via `SET terminal_output = terminal_output || ?`
  - Write cost proportional to each chunk rather than the full buffer
  - Agent record is still truncated to last 10k chars; task output grows for full history
  - Session close preserves the task's output (only deletes the stale agents row)
- **Tasks route** (`packages/backend/src/routes/tasks.ts`):
  - `rowToTask` now takes optional `{ includeTerminalOutput }` flag - only the single-task GET pulls the full output to keep list responses small
  - `/tasks/:id/terminal` falls back to `tasks.terminal_output` when no active agent, so completed/failed/cancelled tasks still return history
- **TerminalHistory component** (`apps/desktop/src/renderer/components/panels/TerminalHistory.tsx`):
  - Fetches task terminal output on mount via `api.tasks.getTerminal`
  - Renders in read-only XTerm with collapse/expand toggle and char count
  - Wired into QueuePanel TaskDetail for `completed`, `failed`, `cancelled` statuses

**Deferred for Phase 15.2/15.4**: structured ndJson conversation log, session resume via Claude CLI, collapsible tool-use sections, history search.

### Session 6 (PR Monitoring + Repository Selector)
- Created PR Monitor service (`packages/backend/src/services/prMonitor.ts`):
  - Polls watched repos every 60 seconds for changes
  - Tracks PR state (reviews, comments, CI status, mergeability)
  - Creates inbox items for:
    - New reviews (approved, changes requested)
    - New review comments
    - New general comments
    - CI failures
    - PR becoming mergeable
  - Filters out user's own comments to avoid self-notifications
  - Initializes state on first poll without creating notifications
- Extended GitHub service (`packages/backend/src/services/github.ts`):
  - Added getPRReviews, getPRReviewComments, getPRComments methods
  - Added GitHubReview, GitHubReviewComment, GitHubIssueComment interfaces
  - Added getConnectedWorkspaces method
- Created repository routes (`packages/backend/src/routes/repositories.ts`):
  - GET / - list watched repos for workspace
  - POST / - add watched repo
  - DELETE /:id - remove watched repo
  - POST /poll - force poll refresh
- Added frontend API client for repositories (`apps/desktop/src/renderer/lib/api.ts`):
  - WatchedRepo type
  - list, add, remove, forcePoll methods
- Updated WorkspaceSettings in SettingsPanel:
  - Real watched repositories list from backend
  - Repository selector with GitHub repo search
  - Add/remove repository functionality
  - Manual poll refresh button

---

## References

### Primary Reference: PostHog Code
**URL**: https://github.com/PostHog/code
**Why**: Best-in-class patterns for agentic development environment

Key patterns to study:
- `packages/agent/` - Agent framework wrapping Claude Agent SDK
- `packages/core/` - Git operations, task execution
- `packages/electron-trpc/` - tRPC over Electron IPC
- Session persistence via `resumeFromLog()` (ndJson conversation logs)
- TreeTracker for git working tree snapshots
- Permission modes: default, acceptEdits, plan, bypassPermissions
- Saga pattern for atomic operations with rollback

### Other References
- PostHog Devbox Code: `/Users/tomowers/dev/posthog/posthog/common/hogli/devbox/`
- Electron React Boilerplate: https://github.com/electron-react-boilerplate/electron-react-boilerplate
- User's current VM setup: SSH accessible via `ssh vm1`
