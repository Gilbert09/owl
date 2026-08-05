# Session prompt — why do fleet runs fail, and how do we get more of them to succeed?

Copy everything below the line into a new session.

---

I want to understand why so many Talyn Fleet runs end in `failed`, and what to
change to raise the success rate. Treat this as an investigation first and a
code change second — I'd rather have three well-evidenced causes than ten
guesses.

## What the system is

Talyn (`~/dev/Gilbert09/fastowl`) is a desktop/web app that delegates PR work to
cloud coding agents. Talyn Fleet (`~/dev/Gilbert09/talyn-fleet`, Go) is our own
runner: fleetd supervises Firecracker microVMs, one per run, with a credential
proxy that injects GitHub/Anthropic tokens host-side so no secret enters the
guest. Read `fastowl/CLAUDE.md` and `talyn-fleet/docs/SPEC.md` before changing
anything — both are detailed and current.

The unit of work is a **task** (`pr_response`, `pr_review`, `code_writing`) which
becomes a **run** on a host. Most tasks today are "get PostHog/posthog#NNNNN
mergeable".

## Where the evidence is

**The durable record is task-side, not fleet-side.** fleetd's run store is
in-memory plus a short-lived per-run ledger, so anything older than the last
restart only exists in the backend's `tasks` table.

- **Admin console**: <https://admin.talyn.dev> — Fleet → Runs / Incidents,
  Product → Tasks. Backed by `/api/v1/admin` (see
  `packages/backend/src/routes/admin/`).
- **Admin API** from a browser tab on admin.talyn.dev (the Supabase JWT is in
  `localStorage`, key contains `auth-token`):
  - `GET /api/v1/admin/tasks?status=failed&limit=50`
  - `GET /api/v1/admin/tasks/:id?transcript=1` — the full agent transcript.
    This read is audited on purpose; it is another tenant's conversation.
  - `GET /api/v1/admin/fleet/runs`, `/fleet/incidents`, `/fleet/hosts?live=1`
- **The host directly** (fastest, and it works when the browser extension
  doesn't). `ssh hetzner-64` is on the tailnet; escalate ONLY via the sanctioned
  command, because sudoers grants NOPASSWD to `systemd-run --slice=fleet.slice *`
  and not to bash:

  ```bash
  ssh hetzner-64 'sudo -n systemd-run --slice=fleet.slice --scope --quiet -- /bin/bash -s' <<'REMOTE'
  . /etc/fleet/secrets.env
  curl -fsS -H "Authorization: Bearer $FLEET_API_TOKEN" http://127.0.0.1:8080/v1/runs
  REMOTE
  ```

  Useful endpoints: `/v1/capacity`, `/v1/runs`, `/v1/runs/{id}/events?after=0`,
  `/v1/goldens`, `/v1/goldens/rebake`, `/metrics`.
  Also `journalctl -u fleetd.service` for the credential proxy's own view —
  it logs every denied route and denied CONNECT with the host.

## Ignore this noise (2026-08-05)

A previous session caused a chunk of the failures currently visible. Do not
spend time diagnosing these; they are understood and fixed:

- Six runs killed by fleetd restarts and a rebaker spin loop that took fleetd to
  209% CPU (`guest did not reconnect`, and three frozen runs reaped by the wedge
  fix). Fixed in `e0511d6`, `8282f08`.
- Any run failing between roughly 11:00 and 16:30 UTC on 2026-08-05.

**Start from failures older than that, or from new ones you generate.** The
interesting ones carry a real cost ($3–$8) — they did work and then failed.

## What I already know is unresolved

- **Cost is missing on runs killed mid-turn.** The Claude SDK only reports
  `total_cost_usd` in its terminal `result` message, so a run cancelled between
  turns has no figure at all — honestly unknown, not zero. Closing that means
  pricing per-message `usage` ourselves. Worth scoping.
- **`maxBudgetUsd` is enforced in the runner and nothing sets it.** The 6h run
  deadline is currently the only bound on what a run can spend.
- **`list_pr_comments` can return 75k+ characters** and blow the agent's
  tool-output limit; the agent then has to read it back from a file. Needs
  pagination or truncation. (`talyn-fleet/runner/src/mcp.ts`)
- **`WebFetch` cannot work in a guest** — its safety check has to reach
  claude.ai. The prompt now says so, but check whether agents still reach for it.
- A first `PostHog/posthog@master` golden now exists and is selectable, so runs
  should stop paying a full clone. Verify that is actually happening.

## What I'd like out of this

1. A ranked list of **why runs actually fail**, with counts and a representative
   transcript or log line each. Distinguish infrastructure failures (proxy
   denials, OOM, timeouts, adoption) from agent failures (gave up, wrong
   approach, hit a wall it couldn't reason past).
2. For the top two or three: a concrete fix or a specific experiment.
3. If a failure class is really "the task was impossible as framed", say that —
   changing the prompt or the task type may beat changing the runner.

## How I work

- Verify before asserting. Read the log, run the query, check the host. If you
  can't verify something, say so rather than inferring.
- Fleet repo: branch off `origin/main`, prefix `tom/`, open a normal PR (never a
  draft). Talyn repo: commit straight to `main`. Commits are signed — if signing
  fails, stop and tell me, never bypass it. No AI-attribution trailers.
- Don't run the whole test suite while iterating; run what you touched.
- Be direct about what you broke or got wrong.
