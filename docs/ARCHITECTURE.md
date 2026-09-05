# Talyn Architecture

Architectural decisions, core concept deep-dives, and resolved questions. Updated when a decision is revisited. For active work see [`ROADMAP.md`](./ROADMAP.md); for the provider abstraction see [`CLOUD_PROVIDERS.md`](./CLOUD_PROVIDERS.md).

## System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                     Electron App (Desktop)                       │
│  ┌───────────────┐ ┌──────────┐ ┌───────────────┐ ┌───────────┐  │
│  │ GitHub panel  │ │  Tasks   │ │  Merge queue  │ │ Settings  │  │
│  │ (Mine/Review) │ │          │ │               │ │           │  │
│  └───────────────┘ └──────────┘ └───────────────┘ └───────────┘  │
└──────────────────────────────────────────────────────────────────┘
                               │
                 WebSocket + REST (Supabase JWT)
                               │
┌──────────────────────────────────────────────────────────────────┐
│                   Backend (hosted on Railway)                    │
│  PR monitor / cache · merge queue · auto-keep-mergeable watcher  │
│  task queue · CloudTaskProvider registry + poller · skills       │
│  webhook receiver (HMAC) → Redis queue → webhook worker          │
└──────────────────────────────────────────────────────────────────┘
        │                      │                        │
  GitHub App             Cloud providers          Supabase Postgres
  (webhooks in,          (PostHog Code,           + Supabase Auth
  REST/GraphQL out)      Anthropic Managed        (RLS), Redis
                         Agents)
```

Nothing executes on the user's machine. Every task is delegated to a **cloud provider** that runs the agent loop on its own sandbox and opens a PR; the backend creates the remote run, polls it, and ingests the transcript.

## Tech Stack

**Frontend (Electron)**
- React 19 + TypeScript
- Zustand (state), Tailwind + shadcn/ui (UI)
- Electron contextBridge for IPC (typed channels); PKCE OAuth via the system browser with a deep-link return

**Backend**
- TypeScript on Node.js, Express + WebSocket
- Supabase Postgres via Drizzle ORM; migrations applied at boot (advisory-locked)
- Supabase Auth (GitHub OAuth) → JWT middleware → per-request RLS scoping
- Redis consumer group for the webhook queue (fleet-safe)
- GitHub connectivity via a single shared **GitHub App**: per-user installations, webhook-first PR state, installation tokens for bot actions + user-to-server tokens for user-attributed ones
- Cloud delegation via the `CloudTaskProvider` registry (`services/cloudProviders/`) — each provider is a self-contained client/credentials/converter/executor/poller module

## Core Concepts (Detail)

### Workspaces
Groups related repositories and integrations. Example: a "PostHog" workspace with `posthog/posthog`, `posthog/posthog.com`, `posthog/charts`. Strictly single-owner; per-workspace provider credentials are AES-GCM-encrypted on the `integrations` row.

### Environments
A secret-free **marker row**, one auto-provisioned per connected cloud provider. Its `type` is how a task resolves its provider — nothing more. (The daemon/SSH-backed execution environments this concept once described were removed in the June 2026 cloud-only refactor.)

### Tasks
Primary unit of work, always delegated to a cloud provider. Types: `code_writing` (freeform prompt on a repo), `pr_response`, `pr_review`; skill runs dispatch as tasks with the `SKILL.md` inlined into the prompt.

Lifecycle: `queued` → `in_progress` → `completed` / `failed` / `cancelled`. The cloud poller drives status and ingests the transcript; review happens on the provider's PR (no local approval gate).

### GitHub / PR core
The heart of the app: webhook-first PR monitoring (with polling reconciliation as the safety net), a per-workspace PR cache, the prioritized GitHub panel (Needs attention / Mine / Review, stacked PRs), the merge queue (auto-fix runs for conflicts/failed checks, bounded check re-runs and branch updates where GitHub allows, and stacked PRs drained bottom-up — each child parked in `awaiting_stack` until the PR its base belongs to lands, then retargeted onto the real base), and the auto-keep-mergeable watcher.

## Key Decisions

### 0. Cloud-only pivot — 2026-06
The local-execution model (bundled daemon, local/SSH environments, in-process Claude agents, approval gates, per-task git working trees) was removed wholesale. Every task runs on a cloud provider's sandbox; Talyn is a PR dashboard + delegation layer. This supersedes decisions 2–7 below, which are kept as history.

### 1. TypeScript Backend (not Python) — 2024-01
Single language across the stack, shared types with frontend.

### 2. Local-first Architecture — 2024-01 *(superseded by 0)*
Backend ran alongside the Electron app. The hosted Railway backend replaced this (Phase 18).

### 3. Environment-agnostic Agent Execution — 2024-01 *(superseded by 0)*
SSH/Coder/daemon execution environments — all removed.

### 4. Use Claude CLI (not API directly) — 2024-01 *(superseded by 0)*
No CLI runs anywhere now; providers own their agent loop.

### 5. Tasks Own Agents — 2024-04 *(superseded by 0)*
Agents are now entirely internal to the provider.

### 6. Git-Centric Task Workflow — 2024-04 *(superseded by 0)*
Branch management moved to the provider sandbox; Talyn tracks the resulting PR.

### 7. Approval-Based Automation — 2024-04 *(superseded by 0)*
The provider opens a normal PR; GitHub review IS the approval gate.

### 8. Reference Architecture: PostHog Code — 2024-04
Reference: https://github.com/PostHog/code — informed session persistence, permission modes, and store/service layering; today PostHog Code is a live provider rather than a pattern source.

### 9. Pluggable cloud providers — 2026-06
One `CloudTaskProvider` interface (registry + per-provider `dispatch`/`reconcile`/credentials/`cancel`), so a new vendor lands as a self-contained module with no core changes. **Talyn Fleet (`selfhosted`) is the default** and PostHog Code is the fall-back; Codex Cloud stays deferred until OpenAI ships a server-to-server API. Claude Code (Anthropic Managed Agents) was removed in September 2026 — it billed metered API credits with no subscription option, which is the opposite of what the fleet offers, and the fleet runs Claude on the workspace's own subscription instead.

### 10. GitHub App over OAuth — 2026-06/07
A single shared GitHub App with per-user installations replaced the classic OAuth app: webhook-first updates, per-installation rate budgets, installation tokens for bot-attributed actions with user-to-server tokens for user-attributed ones (and a documented constraint: GitHub treats both as "the integration" for merge gating).

## References

- **PostHog Code** — https://github.com/PostHog/code
- **Electron React Boilerplate** — https://github.com/electron-react-boilerplate/electron-react-boilerplate
