# FastOwl

**Mission control for AI-assisted software engineering.**

FastOwl is a desktop app that orchestrates Claude agents across your machines, turns incoming signals (PR comments, CI failures, Slack mentions) into a prioritized inbox, and keeps you in the loop with an approval gate before anything lands in the world.

If you work across several VMs or dev containers and find yourself flipping between terminals just to check on a handful of Claude sessions, FastOwl is for you.

---

## Why FastOwl

Running Claude across multiple machines today means:

- SSH'ing into each box to kick off a session
- Tabbing through terminals to see which ones need input
- Manually creating tasks out of PR comments, CI failures, and Slack pings
- Trusting that a long-running agent hasn't silently gone off the rails

FastOwl consolidates all of that into one place:

- **One view of every agent, everywhere.** Spin Claude up on your laptop, your dev VM, or a Coder workspace — FastOwl treats them all as environments.
- **Tasks, not terminals.** You describe what you want. FastOwl creates a task, allocates an environment, spawns Claude in the right repo directory, and gives the work its own git branch.
- **Approval gates.** When an agent finishes, the task pauses at `awaiting_review`. You see the diff + the full terminal transcript, then click Approve or Reject. Nothing gets pushed without you.
- **Prioritized inbox.** New PR comments on your work, CI failures, agent questions, Slack mentions — all funneled into a priority-ordered list so you always know what needs attention next.

---

## Expected workflow

A typical session looks like this:

1. **Open FastOwl.** You see the inbox with anything that came in overnight — a PR review on one of your PRs, a failing check on another, two agent completions awaiting review.
2. **Approve the overnight work.** Click through the awaiting-review tasks. Each one shows the full `git diff` and the terminal transcript. Approve the good ones → they move to completed. Reject a shaky one → it's requeued with a note for the agent to try again.
3. **Create new tasks.** Hit "Add Task", pick a type (Code / PR Response / PR Review / Manual), paste the prompt. Claude picks up a free environment, auto-generates a task title and description, and starts working on a dedicated `fastowl/<id>-<slug>` branch.
4. **Jump into an in-flight task.** Click on an in-progress task to see its live terminal. If Claude asked a question, the inbox surfaces it and the input box is front-and-center. If you want to redirect, type into the terminal like you would in a normal Claude CLI session.
5. **Mark a task ready.** When the agent has landed the changes, click "Ready for Review" — the agent stops and the task waits for your approval + push decision.

You stay in the loop for the decisions that matter (approve / reject / push) and let the agents handle the rote drudgery.

---

## Task types

| Type          | Who does the work | Typical use                                              |
| ------------- | ----------------- | -------------------------------------------------------- |
| `code_writing`| Claude            | Features, bug fixes, refactors. Each task gets a branch. |
| `pr_response` | Claude            | Respond to review comments on one of your open PRs.      |
| `pr_review`   | Claude            | Draft review comments on someone else's PR.              |
| `manual`      | You               | Things only a human can do (merging, replying on Slack). |

All agent types run through the same approval gate before their work is considered done.

---

## Getting started

Clone and install (monorepo — npm workspaces):

```bash
git clone git@github.com:Gilbert09/owl.git fastowl
cd fastowl
npm install
```

Run the app (starts the backend and the Electron desktop shell in parallel):

```bash
npm run dev
```

The backend listens on `localhost:4747`. On first run FastOwl creates a local SQLite database at `~/.fastowl/fastowl.db` and seeds a default workspace + a local environment pointing at your own machine.

### Requirements

- Node.js ≥ 18 (22 recommended)
- `claude` CLI installed and authenticated on any environment where FastOwl should run agents
- Git configured with your GitHub identity on each environment

### Optional integrations

Configured from **Settings → Integrations** inside the app:

- **GitHub**: OAuth flow — enables PR monitoring, PR review/response workflows, and the GitHub panel.
- **Anthropic API** (env var `ANTHROPIC_API_KEY`): enables auto-generation of task titles/descriptions from prompts.
- *(Planned)* Slack, PostHog — tracked in [`docs/ROADMAP.md`](./docs/ROADMAP.md).

---

## Architecture at a glance

- **`apps/desktop/`** — Electron + React 19 + Tailwind + shadcn/ui + xterm.js. Talks to the backend over HTTP + WebSocket.
- **`packages/backend/`** — TypeScript + Express + SQLite (better-sqlite3) + ssh2 + node-pty. Manages environments, spawns Claude, tracks tasks, polls GitHub.
- **`packages/shared/`** — Shared TypeScript types consumed by both.

Data is local-first. The backend is architected to be deployable as a shared service later, but today it lives alongside the Electron app.

---

## Commands

| Command                 | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `npm run dev`           | Run backend + desktop in dev mode with hot reload.              |
| `npm run dev:backend`   | Backend only (watches `packages/backend`).                      |
| `npm run dev:desktop`   | Desktop only.                                                   |
| `npm run build`         | Build shared → backend → desktop in order.                      |
| `npm run lint`          | Lint all workspaces that have a `lint` script.                  |
| `npm run typecheck`     | Strict TypeScript type-check of all packages (no emit).         |
| `npm test`              | Run all workspace `test` scripts.                               |
| `npm run package`       | Package the desktop app for the local platform.                 |

---

## Project status

FastOwl is under active development. See [`CLAUDE.md`](./CLAUDE.md) for project orientation and active priorities, [`docs/ROADMAP.md`](./docs/ROADMAP.md) for the phase-by-phase TODO list, [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for architectural decisions, and [`docs/SESSIONS.md`](./docs/SESSIONS.md) for recent session notes.

Shipped so far: environment management (local + SSH), task queue with live terminal + xterm.js, GitHub OAuth + PR monitoring + PR actions, task branches, approval gates with diff preview + terminal history, typed task system (code/pr_response/pr_review/manual).

In flight: PR response automation, native UI overlays on the Claude terminal, session resume, Slack integration.

---

## License

MIT © FastOwl contributors.
