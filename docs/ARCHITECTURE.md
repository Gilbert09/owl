# FastOwl Architecture

Architectural decisions, core concept deep-dives, and resolved questions. Historical — updated when a decision is revisited. For active work see [`ROADMAP.md`](./ROADMAP.md).

## System Diagram

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

## Tech Stack

**Frontend (Electron)**
- React 19 + TypeScript
- Zustand (state), Tailwind + shadcn/ui (UI), xterm.js (terminals)
- Electron contextBridge for IPC (typed channels)

**Backend**
- TypeScript on Node.js (single-language stack with frontend)
- Express + WebSocket
- SQLite (better-sqlite3) locally; Drizzle ORM scaffolded for hosted Postgres (Supabase) — see [`CONTINUOUS_BUILD_ROADMAP.md`](./CONTINUOUS_BUILD_ROADMAP.md) for the migration
- ssh2 for SSH connections / PTY

## Core Concepts (Detail)

### Workspaces
Groups related repositories and configuration (integrations, repo paths per environment, auto-clone settings). Example: a "PostHog" workspace with `posthog/posthog`, `posthog/posthog.com`, `posthog/charts`.

### Environments
A machine where work executes. Types:
- **Local**: the user's own machine
- **SSH**: remote machines via SSH (e.g., `ssh vm1`)
- **Coder Devbox**: managed workspaces (future)
- **Future**: dev containers, cloud VMs

Git uses the machine's configured git user — no special FastOwl config.

### Tasks
Primary unit of work. Types: `code_writing`, `pr_response`, `pr_review`, `manual`.

Lifecycle: `pending` → `queued` → `in_progress` → `awaiting_review` → `completed` (or `failed` / `cancelled`).

Design principles:
1. **Tasks own agents.** Users manage tasks; agents are internal.
2. **Approval gates.** Automated tasks do work then wait for approval before pushing.
3. **One active task per repo per environment.** Branch isolation.
4. **Session persistence.** Task history and conversation persist; sessions can be paused/resumed.

### Git Branch Management (code_writing)
Each task gets a dedicated branch (`fastowl/task-<id>-<slug>`). Work commits/stashes before another task runs on the same repo. Resume auto-checks out the branch. User approves before merging/pushing.

### Interactive Terminal
Full Claude CLI experience: streaming output, bidirectional input, native UI overlays for options/approvals (planned), full history persistence.

### Inbox
Prioritized list of items requiring human attention: awaiting-approval tasks, awaiting-input tasks, PR reviews received, CI failures, Slack mentions, completed work needing review.

## Key Decisions

### 1. TypeScript Backend (not Python) — 2024-01
Single language across the stack, shared types with frontend, good SSH library ecosystem on Node.

### 2. Local-first Architecture — 2024-01
Backend runs alongside the Electron app; SQLite for persistence; cloud services are optional. Hosted backend is a later addition, not a replacement (see Phase 18).

### 3. Environment-agnostic Agent Execution — 2024-01
Start with SSH (user already has `ssh vm1`); abstract the "environment" so Coder, dev containers, cloud VMs can be added later.

### 4. Use Claude CLI (not API directly) — 2024-01
User already has the CLI set up on environments; CLI handles auth/context; provides the terminal view naturally; output can be parsed for status.

### 5. Tasks Own Agents — 2024-04
Users think in tasks, not agents. Each task spawns its own Claude agent. Terminal output is part of the task. Simpler UI (no separate Terminals panel). Per-environment concurrency preserved.

### 6. Git-Centric Task Workflow — 2024-04
Each code_writing task gets a dedicated branch for isolation, rollback, pause/resume (stash/checkout). One active task per repo per env. Approval before pushing.

### 7. Approval-Based Automation — 2024-04
Automated tasks do work then wait for approval. Different gates per type:
- PR Response: work → show diff → approval → push
- Feature Build: work → await input → user marks complete
- PR Review: suggest comments → approval → post

### 8. Reference Architecture: PostHog Code — 2024-04
Reference: https://github.com/PostHog/code

Patterns adopted/studied:
- Session persistence via conversation log replay (`resumeFromLog()`)
- TreeTracker for git working tree snapshots
- Permission modes (default, acceptEdits, plan, bypassPermissions)
- tRPC over Electron IPC for type-safe communication
- Zustand stores for UI state, services for business logic
- Saga pattern for atomic operations with rollback

## Resolved Questions

1. **Claude integration** — Use the CLI on each environment, not the API directly. Natural terminal view, CLI handles auth, output can be parsed.
2. **Authentication** — OAuth flows for GitHub/Slack/PostHog. Better UX than manual tokens; future-proofed for productionization.
3. **Backend architecture** — Deployable design, local-first development. Runs locally for dev, architected to be deployable later, multi-tenant ready.
4. **Implementation order** — Terminal/agent orchestration first (core value); integrations layered on top.

## References

- **PostHog Code** — https://github.com/PostHog/code — best-in-class patterns for agentic dev environments. See `packages/agent/`, `packages/core/`, `packages/electron-trpc/`.
- **PostHog Devbox** — `/Users/tomowers/dev/posthog/posthog/common/hogli/devbox/` — Coder devbox reference implementation.
- **Electron React Boilerplate** — https://github.com/electron-react-boilerplate/electron-react-boilerplate
