# FastOwl — Claude Context

FastOwl is a desktop "mission control" app for AI-assisted software engineering. It orchestrates multiple Claude agents across environments (local, SSH VMs, dev containers), automates routine work, and provides a prioritized inbox of items needing human attention.

**Target user**: engineers who use Claude heavily across multiple machines simultaneously.

## Git Workflow

**Repository**: `git@github.com:Gilbert09/owl.git` (main branch)

After completing each task: stage relevant files, commit with a descriptive message, push to main. No branches or PRs for FastOwl itself. Keep commits focused and atomic.

## Where Things Live

- **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — system diagram, tech stack, core concept details, key decisions, resolved questions
- **[`docs/ROADMAP.md`](./docs/ROADMAP.md)** — full phased TODO (Phase 1–20), backlog, known gaps, full priority queue
- **[`docs/SESSIONS.md`](./docs/SESSIONS.md)** — chronological session notes
- **[`docs/CONTINUOUS_BUILD_ROADMAP.md`](./docs/CONTINUOUS_BUILD_ROADMAP.md)** — active "production ready" plan (hosted backend, daemon split, etc.)
- **[`docs/DAEMON_EVERYWHERE.md`](./docs/DAEMON_EVERYWHERE.md)** — active refactor: daemon becomes a bundled OS-level user service; collapses local/ssh/daemon into one transport; fixes backend-restart session loss
- **[`docs/CONTINUOUS_BUILD.md`](./docs/CONTINUOUS_BUILD.md)** — user-facing feature doc
- **[`docs/SSH_VM_SETUP.md`](./docs/SSH_VM_SETUP.md)** — running against a remote VM
- **[`docs/SETUP.md`](./docs/SETUP.md)** — env vars / account setup
- **[`docs/TESTING.md`](./docs/TESTING.md)** — testing strategy + coverage
- **[`docs/AUTONOMOUS_BUILD.md`](./docs/AUTONOMOUS_BUILD.md)** — design doc for self-building loops

When a session lands non-trivial work, append a note to `docs/SESSIONS.md`. When a phase item changes status, update `docs/ROADMAP.md`. When a decision is revisited, update `docs/ARCHITECTURE.md`.

## Core Concepts (at a glance)

- **Workspace** — groups related repos + integrations (e.g., "PostHog" = `posthog/posthog` + `posthog/posthog.com` + `posthog/charts`)
- **Environment** — a machine where work runs. Two types, both daemon-backed over WS: `local` (bundled daemon on your Mac/Linux box) and `remote` (paired VM / workstation). Legacy `ssh`/`coder` and in-process `local`-spawn are gone.
- **Daemon** — a `@fastowl/daemon` process that owns child-process pipes; dials the backend over WebSocket. Local daemon ships bundled with the desktop app and runs as a launchd/systemd user service (survives app quit).
- **Task** — the unit of work. Types: `code_writing`, `pr_response`, `pr_review`, `manual`. Lifecycle: `pending` → `queued` → `in_progress` → `awaiting_review` → `completed`
- **Tasks own agents** — users manage tasks; agents are internal, spawned per task
- **Approval gates** — agent tasks land in `awaiting_review` on clean exit; user approves/rejects before anything pushes to the world
- **Git branch per task** — `fastowl/<id>-<slug>`; isolation + resume via stash/checkout
- **Inbox** — prioritized queue of items needing human attention

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full treatment.

## Active Priorities

> Full list in [`docs/ROADMAP.md`](./docs/ROADMAP.md). Definition of done for "production ready" is in [`docs/CONTINUOUS_BUILD_ROADMAP.md`](./docs/CONTINUOUS_BUILD_ROADMAP.md).

1. **Phase 18.5 — Daemon everywhere** (ACTIVE) — see [`docs/DAEMON_EVERYWHERE.md`](./docs/DAEMON_EVERYWHERE.md). One execution path for all envs: daemon runs as a long-lived OS user service bundled with the desktop app. Fixes backend-restart session loss, collapses env types to `local | remote`, rips out SSH.

2. **Phase 18.2 polish** — proper `fastowl login` PKCE flow (replace copy-paste), CLI refresh-token rotation, cross-user HTTP-layer integration test, invite flow. See Session 13 in `docs/SESSIONS.md`.

3. **Phase 17.3 polish** — per-task-type notification toggles, digest mode (batch notifications), click-through opens the task. Basic awaiting_review notification shipped in Session 17.

**Recently landed**:
- Session 17 (Phase 17.3 — notifications quick win): desktop OS notification fires when a task transitions into `awaiting_review`. Toggle + permission hint in Settings → Appearance → Notifications. Uses renderer `Notification` API — Electron bridges to the native OS surface.
- Session 17 (Phase 18.3.B): SSH auto-install. Desktop "Add Environment → Remote VM (FastOwl daemon)" with two modes (auto-install over SSH, manual one-liner). Backend dials the target via ssh2, pipes `curl /daemon/install.sh | bash`, the script builds `@fastowl/daemon` + writes a systemd/launchd unit, daemon pairs + dials back, modal polls for `connected`.
- Session 16 (Phase 18.3.B foundation): daemon relay layer + daemon envs first-class in scheduling + CI hygiene. Daemon runs a local HTTP proxy; child processes' REST calls tunnel over its WS. Backend accepts internal-auth headers in parallel with JWT. No user JWT on the VM. Scheduler/backlog fall back to any connected daemon when no env is pinned.
- Session 15 (Phase 18.3.A): daemon split foundation — new `packages/daemon`, `/daemon-ws` endpoint, `daemon` env type. Daemon can pair with the backend and proxy exec/spawn/git.
- Session 14 (Phase 18.4): backend deployed to Railway at `https://fastowl-backend-production.up.railway.app`. Dockerfile + railway.toml + CI workflow. Desktop `.env` now points at hosted backend.
- Session 13 (Phase 18.2): end-to-end auth — Supabase GitHub OAuth, JWT middleware, `owner_id` scoping, RLS defense in depth, desktop login + CLI/MCP bearer tokens.

## File Structure

```
fastowl/
├── apps/
│   └── desktop/                  # Electron desktop app
│       └── src/
│           ├── main/             # main + preload
│           └── renderer/         # React frontend (components, hooks, stores, lib)
├── packages/
│   ├── backend/                  # Express + WS server, DB, services
│   ├── cli/                      # @fastowl/cli — `fastowl` binary
│   ├── mcp-server/               # @fastowl/mcp-server — stdio MCP for child Claudes
│   └── shared/                   # Shared TS types
├── docs/                         # ARCHITECTURE, ROADMAP, SESSIONS, CONTINUOUS_BUILD*, SETUP, etc.
├── scripts/
│   └── bootstrap-vm.sh           # One-command SSH VM install
├── CLAUDE.md                     # This file
└── package.json                  # npm workspace root
```

Inside `packages/backend/src/`: `db/` (migrations + Drizzle schema/client), `routes/` (REST), `services/` (agent, taskQueue, environment, github, prMonitor, continuousBuild, backlog/, events), `__tests__/` (Vitest + `helpers/fakeEnvironment.ts`).

Inside `apps/desktop/src/renderer/components/`: `layout/`, `modals/`, `panels/`, `terminal/`, `widgets/`, `ui/` (shadcn).
