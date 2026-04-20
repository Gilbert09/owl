# FastOwl Roadmap

Full phased TODO list. Active priorities live in [`CLAUDE.md`](../CLAUDE.md). The "Continuous Build, production ready" line of work has its own breakdown in [`CONTINUOUS_BUILD_ROADMAP.md`](./CONTINUOUS_BUILD_ROADMAP.md).

> **Instructions**: Update this list as work progresses. Mark items completed with `[x]`. Add new items as discovered.

## Priority Queue (Next Up)

> The top three are the active work for "Continuous Build, production ready."
> See `docs/CONTINUOUS_BUILD_ROADMAP.md` for the full plan.

1. ~~**Phase 18.5 — Daemon everywhere**~~ DONE (Session 19) — see [`docs/DAEMON_EVERYWHERE.md`](./DAEMON_EVERYWHERE.md)
   - All 8 slices landed: single-file binary, bundled in .app, launchd/systemd install, auto-pair, env-type collapse (local|remote), session survival + state rehydration + permission-token persistence across restart, lifecycle UI + uninstall, tests + docs
   - Backend restart no longer kills in-flight tasks
   - Zero native deps on the backend (ssh2 + node-pty both retired)
   - Known remaining gap: no ring buffer for session output during disconnect window (tracked in the design doc)

2. ~~Phase 18.3 — Daemon split + auto-install over SSH~~ DONE (Session 17)
   - `packages/daemon` split landed in Session 15 (18.3.A)
   - HTTP relay + daemon-first scheduling landed in Session 16 (18.3.B foundation)
   - Desktop "Add Environment → Remote VM (FastOwl daemon)" with SSH auto-install landed in Session 17
   - Remaining: single-file binary + symmetric uninstall (low priority — git-clone install works today)

3. ~~Phase 17.3 — Notifications on `awaiting_review`~~ DONE (Session 17)
   - Desktop OS notification when a Continuous Build task lands for review. Toggle + permission hint in Settings → Appearance.

--- done above ---

4. ~~Phase 13.3 — Smart Task Creation~~ DONE
5. ~~Phase 13.4 — Repository Context~~ DONE
6. ~~Phase 14.1-14.2 — Git Branch Management~~ DONE
7. ~~Phase 12.8 — Light Mode~~ DONE
8. ~~Phase 15.1-15.3 — Task History~~ DONE
9. ~~Phase 13.1 — Interactive Terminal~~ DONE
10. ~~Phase 16.1/16.2/16.5 — Approval Workflows~~ DONE
11. ~~Phase 20.1-20.6 — Continuous Build (backlog model, scheduler, UI, CLI, MCP, Option 3 deterministic completion)~~ DONE
12. ~~Phase 20.5 prep — `scripts/bootstrap-vm.sh`~~ DONE — one-command VM install pending the daemon work

--- later ---

13. **Phase 13.2 — Structured renderer + native UI overlays** (IN PROGRESS)
    - Slice 1 DONE (Session 18): backend plumbing via `claude -p --output-format stream-json`. `environments.renderer: 'pty' | 'structured'`, `tasks.transcript` jsonb, new `agentStructured` service, interim desktop renderer.
    - Slice 2 DONE (Session 18): `AgentConversation.tsx` (markdown-ish, collapsible tool_use/tool_result/thinking, cost/token footer) + per-tool Approve/Deny UX via a `PreToolUse` hook (`permissionHook.ts` / `permissionService.ts`). "Allow always" persists onto `environments.tool_allowlist`.
    - Slice 3 DONE (Session 18): interactive multi-turn via `--input-format stream-json`; long-lived child per task; `sendMessage` appends user JSONL turns on stdin; `closeInput` for graceful end. Also: removed permission timeout (infinite wait), coalesced inbox items for pending prompts (one per task), boot-time orphan cleanup extended to mark tasks `failed` immediately. Slash-command palette deferred — passes through to the child's own parser.
    - Slice 4 DONE (Session 18): daemon + SSH envs migrated to structured (`stream_spawn` wire op + ssh2 exec channel). PTY code path deleted — no more `node-pty`, `XTerm`, `STATUS_PATTERNS`, `buildFastOwlEnvPrefix`, `spawnInteractive`. `tasks.terminal_output` kept read-only for historical rows; `environments.renderer` defaults to and is back-filled to `'structured'`.
    - Follow-up: deeper backend-restart reliability — keeping in-flight children alive across backend redeploys (currently orphaned children die via SIGPIPE, tasks flip to `failed` on boot). Candidates: co-local daemon, PID reattach, or accept + buy time via graceful SIGTERM-and-wait on shutdown.
14. **Phase 16.3 — Automated PR Response** — hook PR monitor → auto-create `pr_response` tasks on new review comments
15. **Phase 12.5 — Testing framework** — see `docs/TESTING.md`. 66 backend + 7 MCP + 3 CLI + 1 desktop tests now landed
16. **Phase 18 (rest) — Deployment hardening** — after 18.1/18.3/18.4 land

## Backlog

- [ ] **Analytics panel — token / cost usage** — structured-renderer tasks emit a `result` event with `total_cost_usd` + `usage.{input_tokens, output_tokens}` per turn. Surface an Analytics tab that aggregates: per-workspace total spend, per-task spend + token breakdown, per-model usage mix (Opus vs Sonnet vs Haiku), a daily/weekly trend chart. Store a row per `result` event (or aggregate inline). Inspiration: how PostHog / Linear surface "insights" around usage.
- [ ] **Per-tool allowlist patterns (`Bash(git *)`-style)** — today `environments.tool_allowlist` stores tool names as strings, so "Allow always (Bash)" approves every future `Bash` call — broad. The CLI's own `--allowedTools` supports patterns like `Bash(git *)` meaning "only bash commands starting with `git`". Match that: change `permissionService.isPreApproved` to check both exact tool name AND command-pattern match, and update the "Allow always" button to offer a pattern (e.g. extract `git` from `git status` and suggest `Bash(git *)`).
- [ ] **Duplicate "Stop" button on running tasks** — two Stop buttons show up on a task while it's in_progress. Figure out where the second one lives (likely TaskTerminal + TaskDetail both render one) and de-dupe.
- [ ] **Task detail screen is sluggish** — noticeable lag when switching to / interacting with a running task. Likely the terminal output re-render; candidate causes: unbatched WS `task:output` events, xterm writes on every keystroke, full task re-fetch on every status tick. Profile + fix.
- [ ] **Inbox 3-dots menu does nothing** — clicking the three-dots icon on an item in the Inbox panel doesn't open a menu. Find which component renders it and wire up the dropdown actions (mark read, snooze, dismiss, etc.).
- [ ] **Terminal output blanks on task switch** — sometimes clicking off a running task and back shows an empty terminal / "waiting for output" instead of the persisted output. `tasks.terminal_output` column is populated; probably the XTerm component isn't rehydrating from `task.terminalOutput` on remount, only subscribing to live WS events.
- [ ] **XTerm input disabled in strict-autonomous mode** — when a task runs with `--permission-mode acceptEdits` (non-daemon env), Claude can pause on bash / MCP trust prompts. The always-visible input below the terminal works for typing "1"+Enter, but the XTerm itself has `inputEnabled={agentStatus === 'awaiting_input'}`, so arrow-key TUI flows don't work. Consider enabling XTerm input any time the task has a live PTY session, or widening the awaiting-input detection.
- [ ] **Show logged-in user in the app chrome** — bottom-left of the sidebar should display GitHub username + avatar so users know which account they're using (especially on laptops with multiple GitHub accounts).
- [ ] **Auto-connect GitHub integration from the Supabase login session** — today users sign in with GitHub OAuth (Supabase), then *separately* click "Connect GitHub" in Settings → Integrations to run a second OAuth flow. Supabase's sign-in session already returns `provider_token` with `repo` scope — we should pull it off `session.provider_token` on first login and store it as the workspace's GitHub integration token, skipping the second flow.
- [x] **Workspace endpoint returns empty `repos` + `integrations`** — Fixed 2026-04-19. `rowToWorkspace` in `routes/workspaces.ts` was returning hardcoded empty arrays/maps (two `// TODO: Load from ... table` markers). Now batches the joins so `GET /workspaces` is O(1) queries and the sidebar's "N repos" count actually updates when you watch/unwatch a repo.
- [ ] **Coder environments not implemented** — `services/environment.ts` throws `'Coder environments not yet implemented'` on `connect`. Not on the critical path; `daemon` envs + `local` cover the use cases today. Tracked here so it's not rediscovered as a surprise.
- [ ] **`node --ignore-scripts` and other eslint-disables are load-bearing** — a few `eslint-disable-next-line` / `@ts-ignore` sites exist (`middleware/auth.ts` namespace augmentation, `apps/desktop/src/main/main.ts` console usage, Electron ERB build scripts). All intentional and low-risk; noted for a future "lint-cleanup" pass if it's ever worth the churn.
- [x] **Change default ports** — Changed from 3001 to 4747 to avoid conflicts with common dev servers
- [x] **Fix ESLint configuration** — Removed broken 'erb' extends, simplified config, fixed all lint errors

## Known Gaps (tracked but not yet phased)

- **Backend bundling for release**: `npm run package` bundles `apps/desktop` only. The backend is not shipped with the Electron artifact today — users running a packaged build would have no backend unless they run `@fastowl/backend` separately. Needs a Phase 12 sub-item.
- **Credential encryption at rest**: GitHub OAuth tokens and other integration tokens live in SQLite as plaintext (Phase 11.1 subitem).
- **Backend-down UX**: Frontend assumes the backend is reachable at `localhost:4747`. No graceful offline/reconnect indicator beyond the WebSocket auto-reconnect loop.
- **Testing**: Only one smoke test (`apps/desktop/src/__tests__/App.test.tsx`). Full plan in `docs/TESTING.md`. Tracked under Phase 12.5.
- **Release packaging**: CI `publish.yml` builds desktop only on tag push — doesn't build the backend.
- **MacOS notarization**: `afterSign: .erb/scripts/notarize.js` is wired up but untested in the fastowl repo specifically.
- **Multi-step agent state recovery**: A task agent crashing mid-run loses its state (the task does persist, and recovery resets to `queued` via `recoverStuckTasks`, but no partial resume).

---

## Phase 1: Foundation

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

- [x] **1.5 IPC & Communication Layer** (COMPLETED — using HTTP/WebSocket)
  - [ ] Extend Electron IPC channels (deferred — HTTP works for local)
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

## Phase 2: Environment Management

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

- [x] **2.3 Environment UI** (COMPLETED — basic)
  - [x] "Add Environment" modal (with SSH config)
  - [x] Environment list in sidebar
  - [x] Connection status indicators (in sidebar)
  - [ ] Quick actions (connect, disconnect, remove)

- [x] **2.4 Local Environment** (COMPLETED)
  - [x] Local machine as default environment
  - [x] Spawn local processes
  - [x] PTY handling for local terminals

## Phase 3: Terminal & Agent System

- [x] **3.1 Terminal Infrastructure** (COMPLETED)
  - [x] xterm.js integration
  - [x] Terminal component with proper sizing (FitAddon)
  - [x] PTY over SSH (via ssh2 shell)
  - [x] Terminal multiplexing (multiple sessions per environment)
  - [ ] Terminal state persistence

- [x] **3.2 Terminal Panel UI** (REFACTORED — merged into Tasks Panel)
  - [x] ~~Agent list (terminal tabs)~~ — Removed, tasks list replaces this
  - [x] Terminal status indicators (color-coded) — Now on task cards
  - [x] ~~New agent button + modal~~ — Removed, tasks spawn their own agents
  - [x] Stop button — Now on running tasks
  - [x] Terminal view — Now embedded in TaskDetail when task is running

- [x] **3.3 Claude Agent Service** (COMPLETED)
  - [x] Spawn `claude` CLI process on environment
  - [x] Stream stdout/stderr to terminal
  - [x] Parse Claude output for state detection: Idle, Working, Awaiting input, Tool use, Completed, Error
  - [x] Send input to Claude process
  - [x] Agent lifecycle management (start, stop)

- [x] **3.4 Agent Status Detection** (COMPLETED)
  - [x] Regex patterns for Claude output parsing
  - [x] State machine for agent status
  - [x] "Needs attention" detection (questions, errors)
  - [x] Status change events via WebSocket

- [x] **3.5 Agent Panel UI** (REFACTORED — agents are internal, UI moved to Tasks)
  - [x] ~~Agent cards~~ — Task cards now show agent status when running
  - [x] Color-coded by attention needed — On task cards
  - [x] Quick input for questions — In TaskTerminal component
  - [x] ~~Start Agent modal~~ — Removed, "Start Task" button starts agents
  - [x] TaskTerminal component — Shows terminal when task is in_progress

## Phase 4: Task Queue System

- [x] **4.1 Task Service** (COMPLETED)
  - [x] Create task (manual or automated)
  - [x] Task prioritization algorithm
  - [ ] Task assignment to available agents
  - [ ] Task status transitions
  - [ ] Task history

- [x] **4.2 Queue Panel UI** (COMPLETED — now primary view)
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

## Phase 5: Inbox System

- [x] **5.1 Inbox Service** (COMPLETED)
  - [x] Inbox item CRUD
  - [x] Priority calculation
  - [x] Mark as read/done
  - [x] Snooze functionality
  - [x] Inbox item sources (agents, integrations)

- [x] **5.2 Inbox Panel UI** (COMPLETED — basic)
  - [x] Inbox list sorted by priority
  - [x] Item type icons
  - [x] Quick actions per item type
  - [ ] Filter/search
  - [x] Bulk actions (API ready, UI needs wiring)

- [x] **5.3 Agent → Inbox Integration** (COMPLETED)
  - [x] Agent questions create inbox items
  - [x] Agent completions create review items
  - [x] Agent errors create attention items

## Phase 6: GitHub Integration

- [x] **6.1 GitHub OAuth** (COMPLETED)
  - [x] OAuth flow implementation (authorization URL, callback, code exchange)
  - [x] Token storage (in integrations table)
  - [ ] Token refresh (not needed for GitHub — tokens don't expire)
  - [x] Scope management (repo, read:user, read:org)

- [x] **6.2 GitHub Service** (COMPLETED — REST API)
  - [x] REST client setup (using fetch)
  - [x] List repositories
  - [x] PR queries (list, get single)
  - [x] CI status queries (check runs)
  - [x] PR comment creation
  - [ ] GraphQL client (deferred — REST sufficient for now)
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

## Phase 7: Slack Integration

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

## Phase 8: PostHog Integration

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

## Phase 9: Workspace Management

- [x] **9.1 Workspace Service** (COMPLETED — basic)
  - [x] Create workspace (`routes/workspaces.ts` + `useWorkspaceActions`)
  - [x] Configure repos (`routes/repositories.ts` + Settings panel)
  - [x] Configure integrations per workspace (integrations table + Settings panel)
  - [x] Workspace switching (Sidebar workspace selector + store)
  - [ ] Multi-workspace tabs (deferred to 9.3)

- [x] **9.2 Workspace UI** (COMPLETED — basic)
  - [x] Workspace settings panel (SettingsPanel with Workspace section)
  - [ ] Add/remove repos
  - [x] Integration toggles (UI ready, not wired to backend)
  - [ ] Workspace deletion

- [ ] **9.3 Multi-Workspace**
  - [ ] Workspace tabs/windows
  - [ ] Cross-workspace search
  - [ ] Workspace templates

## Phase 10: Intelligence & Automation

- [ ] **10.1 Context Analysis**
  - [ ] Parse repository structure
  - [ ] Identify common patterns
  - [ ] Extract project metadata

- [ ] **10.2 Smart TODOs**
  - [ ] Auto-suggest tasks from PR review comments, TODO comments, GitHub issues, Slack threads
  - [ ] Group related tasks
  - [ ] Priority suggestions

- [ ] **10.3 Automation Rules**
  - [ ] Rule definition (trigger → action)
  - [ ] Built-in rules: PR review received → task; CI failure → fix task; Slack mention → inbox item
  - [ ] Custom rule builder
  - [ ] Rule UI

- [ ] **10.4 Background Planning**
  - [ ] Use Claude to plan work
  - [ ] Generate task breakdown
  - [ ] Estimate complexity
  - [ ] Suggest implementation order

## Phase 11: Settings & Configuration

- [ ] **11.1 Settings Service** (PARTIALLY COMPLETED)
  - [x] Workspace-scoped preferences (autoAssignTasks, maxConcurrentAgents)
  - [x] Integration credentials storage (integrations table — plaintext currently)
  - [ ] Encrypt integration credentials at rest
  - [ ] Top-level user preferences (theme is in localStorage, no user-level store)
  - [ ] Default behaviors per task type

- [x] **11.2 Settings UI** (COMPLETED — basic)
  - [x] Settings panel (SettingsPanel component)
  - [x] Sections: Workspace, Environments, Integrations (Appearance deferred)
  - [ ] Import/export settings

- [ ] **11.3 Keyboard Shortcuts**
  - [ ] Global shortcuts
  - [ ] Panel navigation
  - [ ] Quick actions
  - [ ] Customizable bindings

## Phase 12: Polish & Production

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

- [ ] **12.5 Testing** (IN PROGRESS — Phase A + B landed)
  - See [`docs/TESTING.md`](./TESTING.md) for the full plan (stack, layers, CI wiring, rollout)
  - [x] Phase A: Vitest on backend; desktop Jest setup fixed for headless CI
  - [x] Phase B: Backend service tests — migrations (6), status detection (10), gitService (8), taskQueue (8). Fake-environment harness at `src/__tests__/helpers/fakeEnvironment.ts`
  - [ ] Phase B cont'd: agentService integration tests, prMonitor tests, ai service tests
  - [ ] Phase C: Backend route tests via supertest
  - [ ] Phase D: Frontend hook + component tests
  - [ ] Phase E: Playwright E2E for 5 golden flows

- [ ] **12.6 Documentation**
  - [ ] User guide
  - [ ] Developer docs
  - [ ] API documentation

- [ ] **12.7 Multi-Tenant Backend (Future)**
  - [x] User authentication (Phase 18.2 — Supabase GitHub OAuth, JWT middleware, owner_id on top-level tables, RLS, desktop login + CLI/MCP bearer token)
  - [x] Data isolation (owner_id scoping via workspaces/environments, RLS as defense in depth)
  - [ ] API rate limiting
  - [ ] Deployment configuration
  - [ ] **Invite flow (TODO)** — today anyone with a GitHub account can sign up to a fresh instance; self-hosters use `FASTOWL_ALLOWED_EMAILS` to lock down. Need a proper `workspaces_users` join table, invitation tokens, and UI for inviting teammates before this is truly multi-tenant.

- [x] **12.8 Appearance** (COMPLETED)
  - [x] Light mode theme
  - [x] Theme toggle in settings (Appearance section)
  - [x] System theme detection (auto)
  - [x] Persist theme preference (localStorage)

## Phase 13: Enhanced Terminal Interaction
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
  - [ ] Auto-clone repos on environment setup (optional) — deferred

## Phase 14: Git-Centric Workflow

- [x] **14.1 Task Branch Management** (COMPLETED)
  - [x] Auto-create branch when code-writing task starts (`fastowl/{id}-{slug}`)
  - [x] Track branch per task in database
  - [x] Auto-checkout branch when resuming task
  - [x] One active task per repo per environment (DONE — `findTaskHoldingEnvRepoSlot` in `taskQueue.ts`; both scheduler and `/start` refuse to stomp)

- [x] **14.2 Work State Preservation** (COMPLETED)
  - [x] Before starting new task: base branch is fetched and fast-forwarded via `gitService.prepareTaskBranch`
  - [x] Detect uncommitted changes (gitService.hasUncommittedChanges)
  - [x] `prepareTaskBranch` refuses to start on a dirty tree — the (env, repo) slot should have prevented it; surface the inconsistency rather than branch off half-written state
  - [x] Stash utility available (gitService.stashChanges)

- [x] **14.3 Branch Lifecycle** (COMPLETED — core flow)
  - [x] Delete local branch after approve — branch is pushed to origin then removed locally so the env+repo slot is free
  - [x] Push branch to remote on approve (`gitService.pushBranch` called from `/approve`)
  - [x] Rejected work preserved under `refs/fastowl/rejected/<taskId>` via `gitService.stashToBackupRef` (recoverable with `git checkout -b <name> <ref>`)
  - [ ] List task branches in UI (deferred — not needed once approve→push→delete lands)

- [x] **14.4 PR Creation from Task** (PARTIAL — commit+push landed; PR button deferred)
  - [x] Approve commits the working tree with an LLM-generated message (Haiku via `generateCommitMessage`) and pushes to origin — remote branch is ready for a PR
  - [x] Editable commit message modal in `ApproveTaskModal.tsx` — shift-click Approve to bypass
  - [ ] "Create PR" button on completed tasks (deferred — `gh pr create` wrapper)
  - [ ] Pre-fill PR title/description from task metadata (deferred)
  - [ ] Link PR to task in UI (deferred)

- [x] **14.5 Live file-change view** (COMPLETED)
  - [x] Per-file diff endpoints (`GET /:id/diff/files`, `GET /:id/diff/file?path=...`)
  - [x] `TaskFilesPanel` component — file list + per-file diff viewer; in-flight write pulse from `tool_use` events
  - [x] Terminal/Files tabs in the running-task view; Files tab replaces the inline diff in awaiting_review
  - [x] Live `task:files_changed` WS event driven by `taskFileWatcher` — debounces on `tool_use` for Edit/Write/MultiEdit/NotebookEdit/Bash

- [ ] **14.6 Future: parallel tasks per repo via git worktrees** (DEFERRED)
  - Reasoning: worktrees would drop the (env, repo) single-slot constraint and let multiple tasks work the same repo simultaneously. The blocker is per-worktree dependency state — each worktree needs its own `node_modules` / build artifacts, which is painful in monorepos (posthog/posthog, etc.). Keep single-slot for now; revisit if users hit the queue-behind-awaiting-review pain.

- [ ] **14.7 Future: resume task from a different environment**
  - Periodic `git push -f origin refs/fastowl/wip/<taskId>` from the env running the task; "Move to env X" action fetches + checks out on the target. Lightweight; tackle after users ask for it.

## Phase 15: Session Persistence & History

- [x] **15.1 Conversation Logging** (COMPLETED — raw terminal output)
  - [x] Persist all terminal output to task record (tasks.terminal_output column, append-only)
  - [ ] Store structured conversation (user messages, agent responses, tool calls) — deferred
  - [ ] Persist agent state snapshots — deferred
  - [ ] ndJson format for efficient append — chose plain-text column for simplicity

- [ ] **15.2 Session Resume**
  - [ ] Reconstruct conversation state from logs
  - [ ] Resume Claude session with context (if Claude CLI supports)
  - [ ] Fallback: start new session with conversation summary
  - [ ] "Continue where I left off" functionality

- [x] **15.3 Task History UI** (COMPLETED — basic)
  - [x] View full conversation history for any task (TerminalHistory component in TaskDetail)
  - [x] Scroll through past terminal output (XTerm in read-only mode)
  - [x] Collapsible section (expand/collapse toggle)
  - [ ] Collapsible tool use sections (requires structured log — deferred)
  - [ ] Search within task history — deferred

- [ ] **15.4 Agent Reuse (Investigate)**
  - [ ] Research: Can Claude CLI sessions be paused/frozen?
  - [ ] Research: MCP session persistence capabilities
  - [ ] If possible: implement session serialization
  - [ ] If not: implement context summarization for new sessions

## Phase 16: Task Types & Approval Workflows

- [x] **16.1 Task Type System** (COMPLETED)
  - [x] Define task types: code_writing, pr_response, pr_review, manual (TaskType union in shared)
  - [x] Type-specific behaviors (isAgentTask helper; queue auto-processes anything !== 'manual')
  - [x] Type icons in CreateTaskModal and QueuePanel (Sparkles/MessageSquare/Eye/Hand)
  - [x] Type-specific prompt placeholders in CreateTaskModal
  - [ ] Type-specific default prompts/templates (deferred — just placeholders for now)
  - [x] Migration 005 renames existing 'automated' → 'code_writing'

- [x] **16.2 Approval Gates** (COMPLETED)
  - [x] "Awaiting Review" status routed through (existing `awaiting_review` TaskStatus)
  - [x] Approve/Reject buttons in TaskDetail for awaiting_review tasks
  - [x] "Ready for Review" button in TaskTerminal stops agent + transitions to awaiting_review
  - [x] Agent session close (code === 0) now routes agent tasks to awaiting_review instead of completed
  - [x] Reject resets working tree to base, preserves rejected work under `refs/fastowl/rejected/<taskId>`, re-queues the task with `branch` cleared so the next attempt gets a fresh `prepareTaskBranch`
  - [x] Show diff of changes before approve — replaced inline `TaskDiff` with `TaskFilesPanel` (per-file list + diff viewer) that updates live via `task:files_changed`
  - [x] Commit message review modal with LLM-generated default (Haiku, see `generateCommitMessage`), shift-click to bypass
  - [x] Push only after approval — `/approve` commits the working tree, pushes to origin, then cleans up the local branch
  - [ ] Comments on approval (deferred)

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
  - [ ] Manual-task completion UX (still uses generic status picker — minor polish)

## Phase 17: Automation & Triggers

- [ ] **17.1 Automation Rules (Enhanced)**
  - [ ] PR comment on my PR → create PR Response task
  - [ ] CI failure → create fix task
  - [ ] New PR for review → create PR Review task (optional)
  - [ ] Configure per workspace

- [ ] **17.2 Auto-Start Behavior**
  - [ ] Option to auto-start triggered tasks
  - [ ] Option to just create inbox item for manual start
  - [ ] Rate limiting (max concurrent auto-tasks)

- [x] **17.3 Notification Preferences** (Session 17, basic)
  - [x] Desktop OS notifications for `awaiting_review` transitions — fires a native notification via the renderer's `Notification` API (Electron auto-bridges to macOS Notification Center / Windows Action Center / Linux libnotify)
  - [x] Toggle in Settings → Appearance → Notifications; preference persisted in localStorage
  - [x] Only fires on true status transitions (not idempotent restates)
  - [ ] Per-task-type notification settings — deferred (currently only awaiting_review)
  - [ ] Digest mode (batch notifications) — deferred

## Phase 18: Hosted Backend + Local Daemon

> **Goal**: move from local-only SQLite backend to a hosted control plane (Supabase Postgres + containerized Node server) with a local daemon on the user's machine that handles environment/agent execution. Preserves local-first execution while enabling cross-device state, multi-user auth, and proper productionization.
>
> **Reference architecture**: hosted server owns state + integrations; local daemon owns SSH/PTY/Claude CLI execution; they communicate via an authenticated outbound WebSocket tunnel from the daemon to the server.

- [ ] **18.1 DB abstraction + Postgres/Supabase migration**
  - [ ] Pick a TypeScript ORM with migration tooling — **recommended: Drizzle ORM + drizzle-kit**
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
  - [~] New `packages/server` — hosted control plane. 18.3.A landed the daemon-on-the-other-side of the split; dropping ssh2/node-pty from the backend waits until legacy `local`/`ssh` env types are deprecated.
  - [x] New `packages/daemon` — `@fastowl/daemon` workspace with `executor.ts`, `git.ts`, `wsClient.ts`, `config.ts`, `proxyServer.ts`. Session 15–16.
  - [x] Wire protocol in `@fastowl/shared/daemonProtocol.ts`: hello / request-response / events + proxy_http_request. Session 15–16.
  - [x] Daemon auth: one-shot pairing token → long-lived device token (SHA-256 hash stored). Session 15.
  - [x] **Option-1 HTTP relay for CLI/MCP inside tasks**: daemon runs a localhost HTTP proxy; child processes' REST calls tunnel over the daemon's authenticated WS. Backend accepts internal-auth headers (randomBytes(48) secret, timingSafeEqual) alongside JWT. No user JWT ever lives on the VM. Session 16.
  - [x] **Scheduler/backlog recognise daemon envs**: `daemonRegistry` updates `environments.status` on connect/disconnect; backlog + continuousBuildScheduler treat connected daemon envs as eligible fallbacks. Session 16.
  - [ ] **Bundled daemon**: child process of the Electron app for the user's own machine (replaces `type: 'local'`).
  - [~] **Deployable daemon**: `fastowl-daemon` distributable to VMs (Session 17)
    - [ ] Single-file binary (pkg, bun --compile, or Docker image) — still using git-clone + build for MVP
    - [x] Systemd unit / launchd plist for auto-start — generated by `scripts/install-daemon.sh`
    - [x] Self-register with hosted server on first run using a one-time pairing token from the desktop app — pairing flow works end-to-end from the new "Add Environment" UI
  - [x] **Remote install flow**: given SSH creds for a VM, FastOwl installs the daemon automatically (Session 17)
    - [x] Desktop UI: "Add Environment" → type `Remote VM (FastOwl daemon)` with two modes: auto-install over SSH, or show manual one-liner
    - [x] Backend provisioning: `POST /api/v1/environments/:id/install-daemon` SSHes in (ssh2), pipes `GET /daemon/install.sh` | bash, the script detects arch/OS, clones the repo, builds `@fastowl/daemon`, pairs, writes systemd/launchd unit
    - [x] Health check: desktop polls env status after install, flips to "connected" when the daemon dials back via `daemonRegistry.register`
    - [ ] Uninstall flow: symmetric — remove env in UI optionally tears down daemon on VM (deferred)

- [x] **18.4 Deployment** (Session 14)
  - [x] Multi-stage Dockerfile at repo root — Node 22 slim, copies pre-built node_modules from builder to avoid re-running install-scripts (keeps node-pty/ssh2 native bindings without runtime build tools)
  - [x] `railway.toml` — DOCKERFILE builder, `/health` healthcheck, on-failure restart
  - [x] Hosted at `https://fastowl-backend-production.up.railway.app`, project `FastOwl`, service `fastowl-backend`
  - [x] Service variables: `DATABASE_URL` (transaction pooler, not direct — Railway has no IPv6), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FASTOWL_ALLOWED_EMAILS`, `NODE_ENV`
  - [x] Migrations run on startup via drizzle-orm migrator; `build:copy-migrations` postbuild script puts `.sql` files into `dist/`
  - [ ] Rate limiting on public API (per-user) — future

- [x] **18.5 CI for hosted backend** (Session 14, partial)
  - [x] `.github/workflows/deploy-backend.yml` — path-filtered to backend/shared/Dockerfile, uses `RAILWAY_TOKEN` secret
  - [ ] Separate staging vs production environments (Railway environments feature) — future
  - [ ] Automated Supabase branch creation for PR previews — future
  - [ ] Rollback procedure documented — future

- [x] **18.6 Desktop app integration** (mostly Session 13 + 14)
  - [x] Replace hardcoded `http://localhost:4747` with configurable server URL (`FASTOWL_API_URL` env, webpack EnvironmentPlugin, loaded via dotenv)
  - [x] Desktop points at Railway by default; local fallback via `.env` override
  - [x] Graceful degradation when backend unreachable (App.tsx renders "Backend is unreachable" screen)
  - [ ] First-run flow: choose "Cloud (hosted)" vs "Self-hosted/local" mode — future, not required for production
  - [ ] Encrypt stored JWT at rest via OS keychain (Electron safeStorage API) — future, localStorage persists fine for MVP

- [ ] **18.7 Data migration for existing users**
  - [ ] One-click "Sync to cloud" flow reads local SQLite and pushes to hosted Postgres
  - [ ] Preserve task history, inbox items, workspace config

- [ ] **18.8 Observability — PostHog**
  - PostHog is the single product analytics + error tracking + logs platform for FastOwl; no separate Sentry/Datadog/etc.
  - [ ] Structured logging on server (pino), shipped to PostHog via log-to-events
  - [ ] Error tracking via PostHog error tracking (server + daemon + Electron renderer + main process)
  - [ ] Product analytics events: task created, task approved/rejected, env added, integration connected, time-to-first-agent
  - [ ] PostHog session replay for desktop UX debugging (opt-in only)
  - [ ] Railway platform metrics → PostHog (CPU/mem/request counts) via webhook or periodic push
  - [ ] Dashboards: cohort retention, error rate by route, approval latency histogram
  - [ ] Self-host PostHog or PostHog Cloud — defer decision; cloud is faster to start

## Phase 19: Developer Tooling

> Tools that speed up the dev loop. Add/maintain as we go.

- [ ] **19.1 MCP servers for Claude Code**
  - [ ] **GitHub MCP** (`@modelcontextprotocol/server-github`) — query repo state, PRs, issues, runs
  - [ ] **Supabase MCP** (`@supabase/mcp-server-supabase`) — query hosted DB schema and rows during dev
  - [ ] **PostHog MCP** — query analytics/errors from the editor
  - [ ] **Filesystem MCP** (optional) — scoped to the repo root
  - [ ] Document the MCP setup in [`docs/SETUP.md`](./SETUP.md)

- [ ] **19.2 Scripts + DX polish**
  - [ ] `npm run db:reset` — drop the local SQLite DB and recreate via migrations
  - [ ] `npm run db:seed` — optional seed data for demo purposes
  - [ ] `npm run logs` — tail backend + desktop main-process logs in one stream
  - [ ] Pre-commit hook (husky + lint-staged) for typecheck + eslint on changed files only

- [ ] **19.3 Local `claude` CLI smoke harness**
  - [ ] Fixture transcripts + a test harness that replays them into `agent.analyzeOutput()` to catch regressions

## Phase 20: Continuous Build

> Point FastOwl at a TODO document and it works through the list — one task per item, each with its own git branch, each gated by human approval. See [`docs/CONTINUOUS_BUILD.md`](./CONTINUOUS_BUILD.md) for the full feature doc.

- [x] **20.1 Backlog data model + markdown parser** (COMPLETED)
  - [x] `backlog_sources` + `backlog_items` tables (migrations 006, 007)
  - [x] Markdown checklist parser with heading-scoped sections, nesting, `(blocked)` detection
  - [x] Stable external IDs (hash of text + parent) so reordering doesn't churn state
  - [x] Source sync: read file via `environmentService.exec`, upsert items, retire missing ones
  - [x] REST at `/api/v1/backlog` for sources CRUD + sync + item list
  - [x] 18 unit/service tests (parser + service)

- [x] **20.2 Continuous Build scheduler** (COMPLETED)
  - [x] Domain EventEmitter (`services/events.ts`) so backend services can react to `task:status` transitions without going through websocket
  - [x] Scheduler subscribes to `task:status`, updates backlog item claim/completion, and spawns the next unblocked item when slots are available
  - [x] Workspace-level `continuousBuild.{ enabled, maxConcurrent, requireApproval }` settings
  - [x] Manual-kick endpoint `POST /api/v1/backlog/schedule`
  - [x] Periodic tick (60s) as a safety net for missed events
  - [x] 8 scheduler tests (on/off, cap, approval gate, claim/release, disabled-source skip)

- [x] **20.3 Desktop UI** (COMPLETED)
  - [x] New **Continuous Build** section in Settings: toggle + concurrent cap + approval gate
  - [x] Source management: add/delete markdown_file sources with per-source environment
  - [x] Backlog items view with live status chips (pending/in-flight/done/blocked)
  - [x] "Run scheduler" button

- [x] **20.4 FastOwl CLI (task-spawns-task)** (COMPLETED)
  - [x] New `packages/cli` workspace publishing the `fastowl` binary
  - [x] Commands: `task create/list/ready`, `backlog sources/sync/items/schedule`, `ping`
  - [x] Agent service injects `FASTOWL_API_URL` (local), `FASTOWL_WORKSPACE_ID`, `FASTOWL_TASK_ID` as inline env vars on spawn so child Claudes inherit context
  - [x] 3 CLI client tests + 4 backend env-prefix tests

- [x] **20.5 SSH VM support** (COMPLETED — documentation, code path, and one-command bootstrap)
  - [x] Env prefix skips `FASTOWL_API_URL` for SSH environments (remote `.bashrc` sets it instead)
  - [x] `docs/SSH_VM_SETUP.md` with three networking options (SSH reverse tunnel, LAN bind, backend-on-VM) and troubleshooting
  - [x] `scripts/bootstrap-vm.sh` — idempotent one-command VM install
  - [ ] End-to-end user verification on the real VM (requires user action)

- [x] **20.8 Option 3 — deterministic completion for autonomous tasks** (COMPLETED)
  - [x] Autonomous tasks (those with `metadata.backlogItemId`) spawn `claude --print --permission-mode acceptEdits <prompt>` via the existing `bash -c` non-interactive path
  - [x] Process exit = completion signal. No prompt-based signaling, no hook, no sentinel
  - [x] Interactive tasks keep the existing PTY + prompt-delivery flow
  - [x] Scheduler `buildPrompt` rewritten: tells Claude to stop responding when done (exit is the signal)
  - [x] Fix: SSH `pty:close` now carries the real exit code; agent close handler forwards it
  - [x] Fix: scheduler skips sources whose target environment isn't connected

- [x] **20.6 FastOwl MCP server** (COMPLETED)
  - [x] New `packages/mcp-server` workspace using `@modelcontextprotocol/sdk` over stdio
  - [x] Seven tools: `fastowl_create_task`, `fastowl_list_tasks`, `fastowl_mark_ready_for_review`, `fastowl_list_backlog_items`, `fastowl_list_backlog_sources`, `fastowl_sync_backlog_source`, `fastowl_schedule`
  - [x] Tools pick up `FASTOWL_WORKSPACE_ID` / `FASTOWL_TASK_ID` from env so child Claudes call them argument-free
  - [x] Registration instructions in `docs/SETUP.md` (FastOwl MCP section)
  - [x] 7 handler tests

- [ ] **20.7 Nice-to-haves (deferred)**
  - [ ] GitHub issues as a backlog source type
  - [ ] Linear projects as a backlog source type
  - [ ] Priority inference from source context (currently every item is `medium`)
  - [ ] Cross-source scheduling priority (currently iterates in creation order)
  - [ ] Structured `<!-- depends-on: ... -->` annotations for blocked items
