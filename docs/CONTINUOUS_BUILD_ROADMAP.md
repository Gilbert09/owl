# Continuous Build — Path to Production

> Where we are, where we're going, and in what order. This is the current
> top-of-queue work, not a survey. Keep it short.

## Goal

FastOwl runs autonomously on a hosted backend + a user's VM, works through
TODOs without hand-holding, and the user approves (or rejects) each result
from a single inbox. Setting up a new VM takes one click + SSH creds —
no manual CLI installs, no reverse tunnels, no bashrc edits.

## Where we are (shipped)

- **Continuous Build feature end-to-end in the code**: backlog model,
  scheduler, desktop UI, per-workspace toggle. See
  [`CONTINUOUS_BUILD.md`](./CONTINUOUS_BUILD.md).
- **Task-spawns-task**: `@fastowl/cli` and `@fastowl/mcp-server` both wired
  up. Child agents inherit `FASTOWL_*` env vars.
- **Option 3 (deterministic completion)**: scheduler-spawned tasks run
  `claude --print --permission-mode acceptEdits`. Process exit = task done.
  No prompt trickery, no hook, no output parsing. Interactive tasks still
  use the TUI.
- **SSH VM path works manually**: [`SSH_VM_SETUP.md`](./SSH_VM_SETUP.md)
  walks through it. But it's manual — several steps, three networking
  options, `.bashrc` edits.

## What's next (in order)

### 1. Hosted backend ← current focus

Drop the "backend on laptop + reverse tunnel" model entirely. Run the
backend on a real host, use a real database, and connect desktop + VMs
to it over the public internet (HTTPS + auth).

**Concretely** (Phase 18.1 / 18.4 in [`ROADMAP.md`](./ROADMAP.md)):

- Pick an ORM with migration tooling — **Drizzle** (TS-first, Supabase-friendly)
- Port migrations 001-007 from hand-rolled SQL to Drizzle
- `DatabaseClient` interface so services don't depend on `better-sqlite3` directly
- Supabase project for Postgres + Auth (GitHub OAuth for sign-in)
- Deploy the backend on **Railway** (WS-friendly, GitHub-integrated, cheap; MCP server available for agent-driven deploys)
- Add `user_id` scoping to every row + RLS policies
- Desktop: replace hardcoded `http://localhost:4747` with a configurable
  URL + JWT in the Electron safeStorage

**Why this is next**: the reverse-tunnel / `.bashrc` dance is the single
biggest "how do I use this?" friction point. Until backend is hosted,
nothing else matters. Also: multi-machine use (laptop + desktop + phone)
is impossible with a local-only backend.

### 2. Backend / daemon split + automated VM install

Once the backend is hosted, a VM only needs to run the **daemon** — a
small outbound-WS-connected process that handles environment/agent execution.
Installing that should be a single command we run via SSH on the user's
behalf, not something the user copy-pastes from a doc.

**Concretely** (Phase 18.3):

- Extract environment/agent/git services into `packages/daemon`
- Hosted backend talks to daemons over an authenticated outbound WebSocket
  (daemon dials the server; server never connects to daemons)
- Daemon as a single-file binary — try `bun --compile` first, fall back to
  `pkg` or a Docker image. Needs to ship for linux/amd64, linux/arm64,
  darwin/arm64 at minimum.
- Pairing flow: desktop UI mints a one-time token, daemon registers with
  hosted server on first run using that token.
- **Auto-install over SSH** (the thing the user actually cares about):
  - Desktop "Add SSH environment" dialog gets an **"Install FastOwl daemon"**
    checkbox (default on).
  - On confirm, the backend SSH-es in, detects arch/OS, downloads the
    right binary, drops a systemd unit (or launchd plist), writes the
    pairing token into a config file, and starts the service.
  - Also installs Claude CLI + authenticates (using the user's Claude
    subscription token, ideally — otherwise prompt for API key).
  - Health-check: daemon must connect back to the hosted server before
    the env is marked ready.
  - Uninstall flow is symmetric: removing the env in the UI optionally
    tears down the VM daemon + service.

**Why this is second**: depends on #1. But it's the killer feature —
"give me SSH creds and I'll do the rest" is the moment FastOwl feels
like a real product.

### 3. Agent SDK migration (optional, quality-of-life)

Right now autonomous tasks use `claude --print`. Interactive tasks use
the `claude` CLI in a PTY. Both are shelling out to the CLI binary.

The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) would let us
run Claude as a library call inside the daemon. Benefits:

- Structured message events (text / tool use / results) instead of PTY bytes
- Terminal UI becomes something we render ourselves, consistently across interactive + autonomous
- Granular `permissionMode` / `allowedTools` / `maxTurns` per task
- Easier to intercept (e.g., auto-approve certain tools, reject others)

**Tradeoffs**: rewrites our terminal streaming and much of the agent.ts
state machine. Also means losing the built-in Claude Code TUI quirks
(syntax highlighting, slash commands) — we'd re-implement what we care
about.

**Why this is third**: current `claude --print` path is sufficient for
autonomy. The SDK is a rewrite that would pay off most in a
post-daemon world (we'd control the whole loop anyway). Defer unless the
CLI starts hitting walls.

## Definition of done

Continuous Build is "production ready" when:

1. A new user can sign up, add an SSH VM, and have Continuous Build
   running on [`ROADMAP.md`](./ROADMAP.md)'s Priority Queue within 10 minutes, with zero
   manual installs or config edits.
2. The system runs unattended overnight: tasks land in the inbox, the
   scheduler respects the approval gate, failures don't cascade.
3. The VM and the laptop can be closed and re-opened independently —
   no state is lost because all of it is in the hosted backend.
4. Notifications fire when a task hits `awaiting_review` so the user
   doesn't need to poll the app.

Items 1-3 = Phase 18 work above. Item 4 = Phase 17.3 (small, do alongside).

## What's NOT on the critical path

- Agent SDK migration (nice-to-have)
- GitHub issues / Linear as backlog sources (nice-to-have; markdown covers us)
- Cross-source scheduling priority (one-source users don't hit this)
- Multi-agent parallelism per workspace (`maxConcurrent` > 1 works but
  untested at scale)
- Dependency-aware backlog parsing (`<!-- depends-on: ... -->`)

These land when they land. None of them block "production ready" as
defined above.
