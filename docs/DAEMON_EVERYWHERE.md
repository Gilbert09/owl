# Daemon Everywhere

> **Status**: IN PROGRESS · this doc is the authoritative task list for the refactor.
> **Goal**: one execution path for both local and remote envs, via the daemon. The local daemon is a long-running OS-level background service that outlives the desktop app.
> **Owner**: Tom. Updates land to `main` with every slice.

## Why

1. Divergent logic between `local`/`ssh`/`daemon` causes bugs — the local path still uses in-proc `child_process.spawn`; daemon path goes through a WS registry. One path is cheaper to reason about and test.
2. Backend restart/redeploy currently kills local tasks. The child's stdin is wired to the backend process, so backend exit ⇒ SIGPIPE ⇒ dead child ⇒ task flips to `failed` on boot (`services/agent.ts:97` `cleanupStaleAgents`). This is the single most painful failure mode in day-to-day use.
3. SSH env type is legacy — no users, and daemon-on-VM (Phase 18.3) subsumes it.

## What "daemon everywhere" means

- Every executing environment is a daemon environment. Under the hood, DB env `type` becomes `local` or `remote` — both transport exec/stream/git over the daemon WS protocol. The DB/UI concept of "daemon" as a separate type goes away; "daemon" is transport, not a user-facing category.
- The desktop app ships a compiled daemon binary. On first launch, it installs the daemon as a **user-level OS service** (launchd agent on macOS, `systemd --user` unit on Linux, Startup registry entry or Task Scheduler on Windows) and pairs it with the hosted backend.
- The daemon runs independently of the desktop app. Quitting Electron, putting the laptop to sleep, closing the window — none of these stop the daemon. Running children keep running. Only a hard force-kill, reboot, or explicit "Stop FastOwl daemon" command terminates it.
- Backend restart no longer orphans tasks. The daemon owns the child pipes; when the backend reconnects, the daemon advertises its live sessions and the event stream resumes from a buffered backlog.

## High-level architecture change

Today:

```
Electron app ─┐
              ├─► Hosted Backend (Railway) ──► child_process.spawn (local env)
CLI / MCP ────┘                          └─► ssh2 exec (ssh env)
                                         └─► WS to remote VM daemon (daemon env)
```

After:

```
Electron app ──┐
               ├─► Hosted Backend ──► WS ──► Local user-service daemon ──► child_process.spawn
CLI / MCP ─────┘                 └─► WS ──► Remote VM daemon            ──► child_process.spawn
```

Backend knows only one wire protocol: `daemonProtocol`. Local daemon is always there, installed on first app launch and running as an OS service.

## Slices

Each slice is independently landable and pushable to `main`. Mark `[x]` when merged.

### Slice 1 — Compile daemon to a single binary

- [ ] `packages/daemon`: spike `bun build --compile --target=bun-darwin-arm64 src/index.ts --outfile dist/fastowl-daemon-darwin-arm64`. Verify it runs, dials a local backend, pairs. If `ws` or any other dep breaks under `bun --compile`, escape-hatch is `pkg`/`ncc`+node SEA.
- [ ] Add a build script per target: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win-x64`.
- [ ] Wire into CI (`.github/workflows/*`) so each push produces artifacts for the desktop app to consume.
- [ ] Confirm the compiled binary still respects `--backend-url` and `--pairing-token` flags (they're handled in `src/config.ts:90`).

**Done when**: running `./dist/fastowl-daemon-darwin-arm64 --backend-url=... --pairing-token=...` pairs successfully end-to-end without any node install on the host.

### Slice 2 — Ship the binary inside the Electron app

- [ ] Electron Builder: add `extraResources` for the compiled daemon binary per platform. Resolve at runtime with `process.resourcesPath`.
- [ ] Add a dev-mode fallback: in `NODE_ENV=development`, use `packages/daemon/src/index.ts` via `tsx`. Same entry-point resolution, different path.
- [ ] Nothing else runs yet — binary is just on disk inside the `.app` bundle.

### Slice 3 — Local daemon as an OS user service

- [ ] macOS: Electron main writes `~/Library/LaunchAgents/com.fastowl.daemon.plist` with `KeepAlive`, `RunAtLoad`, and `ProgramArguments` pointing at the copied binary in `~/Library/Application Support/FastOwl/daemon/`. Calls `launchctl bootstrap gui/<uid>` to install, `launchctl bootout` to uninstall. `KeepAlive=true` means the OS restarts the daemon if it crashes.
- [ ] Linux: write `~/.config/systemd/user/fastowl-daemon.service`, `systemctl --user daemon-reload && systemctl --user enable --now fastowl-daemon`.
- [ ] Windows: Startup folder shortcut or Task Scheduler entry (defer — darwin first, then linux, then windows).
- [ ] Install / uninstall / status helpers live in `apps/desktop/src/main/localDaemon.ts`. Pure shell-out to `launchctl` / `systemctl`.
- [ ] On app launch: check status. If not installed, install. If not running, start.

**Done when**: launching the desktop app for the first time installs and starts the daemon; quitting the app leaves it running; rebooting the machine brings it back up automatically.

### Slice 4 — Auto-pair the local daemon

- [ ] On first app launch with no local daemon env: backend call `POST /api/v1/environments` with `{type: 'local', name: 'This Mac', …}` → returns env + pairing token.
- [ ] Electron main writes pairing token into `~/.fastowl/daemon.json` (the daemon already reads this; see `packages/daemon/src/config.ts:44`).
- [ ] `launchctl kickstart` (or `systemctl restart`) the daemon so it picks up the token.
- [ ] Daemon dials backend, pairs, backend responds with `deviceToken` (long-lived), daemon persists it, env flips to `connected`.
- [ ] UI surfaces the env in whatever "This machine" affordance makes sense (not in the generic env picker — daemon is impl detail).

**Done when**: first launch on a fresh install produces a paired local env with zero clicks.

### Slice 5 — Collapse env types to `local | remote`, route everything through daemon

- [ ] `packages/shared`: rename `EnvironmentType` union. `local` stays (now means "local daemon"). `daemon` → `remote`. `ssh` → removed. `coder` → removed (already stubbed).
- [ ] DB migration: `environments.type` enum shrinks. Drop any `ssh`/`coder`/`daemon` rows or rewrite to new values. No users, so data preservation unnecessary.
- [ ] `packages/backend/src/services/environment.ts`:
  - Delete `localProcesses` + `localStreams` maps, `spawnLocalStreaming`, direct `spawn()` calls.
  - All exec / stream / write / kill routes through `daemonRegistry.request()`.
  - Keep the event-forwarding wire — it's already unified.
  - Delete `fixLocalEnvironmentStatus` — local env status now derives from daemon connection like any other.
- [ ] Delete `packages/backend/src/services/ssh.ts` entirely. Delete its tests. Delete `@types/ssh2`, `ssh2` from dependencies.
- [ ] Delete the SSH "Add environment" UI panels and the `install-daemon` SSH auto-install route (replace remote-VM onboarding with a "paste this one-liner on the VM" flow; existing daemon install script still works).
- [ ] Delete `docs/SSH_VM_SETUP.md`.

**Done when**: `git grep -i ssh2` returns nothing in `packages/`; all tests green; local and remote tasks both run via daemon.

### Slice 6 — Session survival across backend restart (*the `cleanupStaleAgents` rework*)

- [ ] **Daemon side**: add a bounded per-session ring buffer (e.g., 4MB, drop oldest) for stdout/stderr that records everything emitted while the WS is closed. On reconnect, flush buffered events before accepting any new requests from backend.
- [ ] **Daemon hello**: extend `DaemonHello` with `activeSessions: [{sessionId, agentId, pid, startedAt}]`. Backend uses this as the source of truth for "which children are alive."
- [ ] **Backend `daemonRegistry`**: on `hello`, store the session list. Mark agent rows `reconciling` (new status) for any agents whose daemon is still connecting within a grace window. After grace (60s), agents not reclaimed → `failed`.
- [ ] **`services/agent.ts:97` `cleanupStaleAgents`**: rewrite. No longer blanket-fails on boot. Instead marks orphans as `reconciling`, waits for their env's daemon to `hello` in. Any agent a live daemon didn't claim is genuinely dead (the daemon would know) → `failed`.
- [ ] Add `TaskStatus` → `reconciling` (or overload `in_progress` with a sub-flag — pick one; leaning toward `in_progress` + UI badge).
- [ ] **Desktop**: task row shows "reconnecting…" during reconcile; terminal panel rehydrates from the daemon's flushed backlog when reconnect completes.

**Done when**: run a long task, `SIGKILL` the backend (simulating a Railway redeploy), restart the backend, confirm the task continues without being marked `failed` and without losing output.

### Slice 7 — Lifecycle integration in the desktop app

- [ ] "About FastOwl" surface: daemon version, daemon PID, daemon status (running/stopped/crashing).
- [ ] Menu item: "Restart FastOwl daemon" (dev/debug utility).
- [ ] Uninstall flow: if the user uninstalls the desktop app, a uninstall hook or README step must `launchctl bootout` / `systemctl --user disable --now fastowl-daemon`. Otherwise the daemon zombies indefinitely. Ship a `Scripts/fastowl-uninstall.sh` helper inside the `.app`.

### Slice 8 — Tests + docs

- [x] `docs/ARCHITECTURE.md` rewritten: system diagram, two-type env model, zero-native-deps tech stack.
- [x] `docs/SESSIONS.md` Session 19 entry covering all 8 slices with commit hashes.
- [x] `docs/ROADMAP.md` Phase 18.5 marked done.
- [x] `CLAUDE.md` Core Concepts env section rewritten; "Daemon" bullet added.
- [x] `daemonRegistry.test.ts` fixtures updated with `liveSessionIds` to match the Slice 6 interface.
- [ ] **Deferred** — Integration test for the Slice 6 reconcile sweep. First draft (`agentReconcile.test.ts`) hung under vitest: the `resumeRun` stub returned a forever-pending `completion` promise that deadlocked teardown. The logic is narrow + manually smoke-tested (pkill -9 → restart leaves the task in_progress). Needs a stub with a resolvable promise and probably a refactor so `cleanupStaleAgents` is callable without booting the full service graph.
- [ ] **Deferred** — Ring buffer for session output during disconnect. Output emitted while the WS is dead is still dropped; only new output after reconnect flows through. Daemon side: bounded ring buffer per session; replay on reconnect.
- [ ] **Deferred** — Unit tests for `localDaemon.ts` (launchctl/systemctl mocks). The module is mostly shell-outs, so an integration test via a packaged build is higher-value than mocked unit tests.

## Open questions (resolved)

- **Bundling format**: single compiled binary inside the desktop `.app`. Ship per-platform.
- **SSH users**: none exist. No migration needed. Just delete.
- **Daemon visibility in UI**: daemon is impl detail. User-facing concepts are "local" and "remote" envs.
- **Include `cleanupStaleAgents` rework**: yes — Slice 6.

## Risks

- **`bun --compile` + native deps** (Slice 1): `ws` is pure JS and should be fine, but verify. If it breaks, fall back to Node SEA or `pkg`.
- **Code signing** (Slice 2): the nested daemon binary inside the signed `.app` needs its own signature or Gatekeeper rejects the bundle. Confirm Electron Builder's `afterSign` hook covers extra resources; otherwise add a manual `codesign --deep`.
- **launchd quirks** (Slice 3): `bootstrap` vs `load` semantics, `gui/<uid>` domain, user session vs login-item scope. Likely a half-day to get right across macOS versions.
- **Race: daemon reconnects before backend loads agent rows** (Slice 6): ordering matters. `agent.ts` init must load rows *before* `daemonRegistry` accepts `hello` reconciles, or buffer reconciles until ready.
- **"Pause laptop → lose WS → wake up" recovery** (Slice 6): already exercises the same code path as backend restart. Should come for free, but worth an explicit test.

## Cross-cutting things to not forget

- When env type shrinks, audit every `env.type === '…'` switch across backend + desktop. Grep: `env\.type\s*===`, `case 'local'`, `case 'ssh'`, `case 'daemon'`.
- Migrations file: new one at `packages/backend/src/db/migrations/NNN_daemon_everywhere.sql`. Renames `daemon` → `remote`, drops `ssh`/`coder`, no-op for `local`.
- CLI / MCP / backlog sources that reference `env.type`: probably just the scheduler fallback logic in `continuousBuildScheduler.ts`.
