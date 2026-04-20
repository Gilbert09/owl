# FastOwl Session Notes

Chronological notes from development sessions. Most recent first. See [`CLAUDE.md`](../CLAUDE.md) for the project context and [`ROADMAP.md`](./ROADMAP.md) for the phased TODO.

## Session 18 (structured-renderer Slice 3 — interactive multi-turn + reliability polish)
Interactive structured tasks: user-initiated tasks on a structured local env now run against a long-lived `claude -p --input-format stream-json --output-format stream-json` child. User types, child processes a turn, emits a `result` event, we flip status to `idle`, user can type again. Same strict-permission machinery as Slice 2 still applies — hook fires on every tool, UI shows Approve/Deny inline. Plus a batch of reliability / UX polish:

- **Streaming-input mode** in `agentStructured.ts`: new `interactive: boolean` option on `StructuredRunOptions`. When true, args include `--input-format stream-json`, the seed prompt is wrapped as a stream-json `{type:"user", message:...}` envelope, and stdin stays open. New methods:
  - `sendMessage(sessionKey, text)` — writes a user-message JSONL envelope to the child's stdin. Throws if the run is one-shot or stdin is already closed.
  - `closeInput(sessionKey)` — graceful end of conversation. Child finalises current turn, exits with code 0, task → `awaiting_review`.
  - `stop(sessionKey)` unchanged — hard SIGTERM for aborts.
- **Turn-complete signalling**: new `turn_complete` event emitted on each `result`. `agentService` listens and flips agent status back to `idle` for interactive runs so the desktop re-enables the input box.
- **Dispatcher change** (`agent.ts`): dropped the `autonomous && prompt` gate. A structured local env now drives **all** tasks through the structured path — autonomous ones as one-shot, user-initiated ones as interactive. `sendInput(agentId, text)` routes to `agentStructuredService.sendMessage()` for structured sessions, existing `writeToSession()` for PTY.
- **No more timeout on permission prompts**: removed `DECISION_TIMEOUT_MS` + setTimeout from `permissionService`. Pending requests now wait indefinitely. Rationale: matches the "inbox item sits until you look at it" mental model; backend-restart case was already handled by SIGPIPE-on-closed-pipe killing the child regardless; cheapens a queued prompt to a setImmediate-level wait instead of a live-timer.
- **Inbox coalescer for pending prompts** (`packages/backend/src/services/permissionInbox.ts`, ~140 LOC): subscribes to `permissionService` events at backend init. First pending prompt on a task inserts one `agent_question` inbox item. Subsequent prompts bump a counter + swap the summary in place (no new items). Last pending resolved → `status: 'actioned'` + `actionedAt` stamp. Had to add an `insertReady` promise to the tracked entry so concurrent update requests await the initial INSERT — otherwise UPDATEs could silently hit 0 rows against a not-yet-persisted `id`.
- **Boot-time orphan cleanup** (`agent.ts` `cleanupStaleAgents`): extended to also flip the orphaned tasks themselves from `in_progress` → `failed` with `result.error = 'backend restart orphaned the agent'`. Previously `cleanupStaleAgents` only dropped agent rows; tasks would ghost for up to 20 min until `recoverStuckTasks` caught them. Now the post-deploy ghost window is seconds. (Deeper reliability work — keeping children alive across restarts — is queued as a follow-up; not in scope for Slice 3.)
- **Desktop input bar upgrade** (`TaskTerminal.tsx`): old single-line `<input>` replaced with an auto-growing `<textarea>` (1–8 rows). Enter sends; Shift+Enter inserts a newline. Structured tasks: send disabled while the agent is `working` / `tool_use`; placeholder reflects state ("Claude is working…", "Type your response…", etc.). PTY tasks: behaviour unchanged (always enabled — answering TUI prompts needs immediate writes).
- **Deferred to follow-ups** (not in Slice 3 despite being on the original plan):
  - Session resume across process restarts (needs `--session-id` + dropping `--no-session-persistence`). The `handleStructuredExit` path currently writes `failed` on non-zero exit — resuming would require a different lifecycle.
  - Slash-command palette UI (Cmd+K). Not needed: the child's own parser handles `/clear`, `/model`, `/compact`, etc. when we pass the text through as a user message.
  - `@file` refs, image paste, `!shell`. Parity polish; independent from this plumbing.
- **Tests** (+5 inbox, +3 agentStructured): `permissionInbox.test.ts` covers first-request creates item, coalescing with counter, last-resolved auto-actions, per-task separation. `agentStructured.test.ts` extended with `buildClaudeArgs` assertions for interactive flag + strict-mode + interactive combined. Full suite: **109 tests** passing in ~41s.

- **Files**: `packages/backend/src/services/agentStructured.ts`, `packages/backend/src/services/agent.ts`, `packages/backend/src/services/permissionService.ts`, `packages/backend/src/services/permissionInbox.ts` (new), `packages/backend/src/index.ts`, `packages/backend/src/__tests__/permissionInbox.test.ts` (new), `packages/backend/src/__tests__/permissionService.test.ts`, `packages/backend/src/__tests__/agentStructured.test.ts`, `apps/desktop/src/renderer/components/panels/TaskTerminal.tsx`.

## Session 18 (structured-renderer Slice 2 — AgentConversation + per-tool permission UX)
Builds on Slice 1's plumbing. Strict-mode autonomous tasks now run through a `PreToolUse` hook that blocks the CLI on every tool call until the user clicks Approve / Deny in the desktop. "Allow always" persists onto an env-scoped tool allowlist so repeated approvals stop pestering you. The conversation UI replaces Slice 1's interim event dump with a proper block view.

- **Hook mechanism** (`packages/backend/src/services/permissionHook.ts`): a dependency-free CJS script written to `/tmp/fastowl-hook-<random>/permission.cjs` at first strict-mode run. Reads the PreToolUse JSON on stdin, POSTs to the backend with `x-fastowl-permission-token`, writes the `{hookSpecificOutput:{permissionDecision}}` decision to stdout. Defaults to `deny` on any error — a broken backend never silently grants a tool. Script lives for the backend process lifetime; idempotent writer.

- **Permission service** (`packages/backend/src/services/permissionService.ts`, ~200 LOC): in-process state machine. `registerRun()` mints a per-run token (random 24 bytes, hex) the child needs to present for any permission call; `verifyRunToken` is timing-safe. `requestDecision()` short-circuits to `allow` if the tool is on `environments.tool_allowlist`, else registers a pending entry and emits a `request` event, awaiting `respond()`. 10-minute auto-deny timeout. `unregisterRun()` on agent exit denies any still-pending requests so a killed child never leaves the CLI wedged.

- **Routes** (`packages/backend/src/routes/permission.ts`): `POST /api/v1/permission-hook` (unauth'd by JWT, token-auth'd via header) is what the child hook hits. `POST /api/v1/tasks/:id/permission` (JWT-auth'd) is what the desktop hits when the user clicks a button — ownership checked via `tasks → environments.owner_id`. `GET /api/v1/tasks/:id/permission/pending` replays open prompts for reconnect.

- **Schema**: `0007_env_tool_allowlist.sql` adds `environments.tool_allowlist jsonb default '[]'`. Populated by the "Allow always" button. Scoped per-env (not per-task) — one approval sticks for every future task on that machine.

- **Wire protocol**: two new WS event types, `agent:permission_request` and `agent:permission_response`. We *also* inject synthetic `fastowl_permission_request` / `fastowl_permission_response` / `fastowl_permission_auto_allowed` events into the transcript so the renderer has a single ordered stream; the dedicated WS types are kept for future standalone notification patterns. Force-persist on any fastowl-synthetic event so a reconnect mid-prompt sees the pending card (can't wait for the usual every-25-events sample).

- **Dispatcher change** (`packages/backend/src/services/agent.ts`): structured runs now respect `env.autonomousBypassPermissions` — `true` → `--permission-mode bypassPermissions` (no hook), `false` → `--permission-mode default` with the hook. Bypass for throwaway daemons, strict for everything you care about. Strict mode also sets `FASTOWL_PERMISSION_TOKEN` + `FASTOWL_AGENT_ID` + `FASTOWL_ENVIRONMENT_ID` in the child's env so the hook can authenticate and the backend can scope allowlist lookups.

- **Renderer** (`apps/desktop/src/renderer/components/terminal/AgentConversation.tsx`, ~450 LOC): replaces the interim `StructuredTranscript.tsx` (deleted). Collapses the event stream into a block model (text / thinking / tool_use / tool_result / permission / system / result) and renders each block with its own component. Text blocks get a hand-rolled markdown-ish renderer (newlines preserved, fenced code blocks, inline backticks — no new deps). Tool_use / tool_result / thinking blocks are collapsed by default; click to expand to full JSON / raw output. Permission blocks show the tool name + JSON input + three buttons: **Allow once**, **Allow always (tool)**, **Deny**; auto-collapse into a green/red summary when the corresponding `fastowl_permission_response` event arrives. Footer shows cost / tokens / denial count from the `result` event.

- **Desktop API** (`apps/desktop/src/renderer/lib/api.ts`): new `api.tasks.respondToPermission(taskId, requestId, decision, persist)` + `api.tasks.listPendingPermissions(taskId)`.

- **Tests** (+13): `permissionService.test.ts` covers the full state machine — token mint + verify, pre-approved tool auto-allows without emitting a request event, non-approved tool registers pending + fires `request`, allow+persist writes the allowlist, allow-without-persist doesn't, unknown requestId returns false, 10-minute timeout auto-denies, `unregisterRun` resolves pending as denied, `listPendingForTask` scoping. Uses `vi.useFakeTimers()` for the timeout assertion. Full suite: **115 tests** passing in ~30s.

- **Deliberate scope boundaries for Slice 2**:
  - Still autonomous-only on local envs (same gate as Slice 1). Interactive user-initiated tasks land in Slice 3.
  - Allowlist is exact tool-name match (`Read`, `Bash`). Pattern matching like `Bash(git *)` — which the CLI's own `--allowedTools` supports — comes later if users want it.
  - Daemon / SSH envs still use PTY (they don't have the hook script or a streaming-exec op yet). Structured + these env types is a Slice 4 follow-up.
  - No global "allow any of: Read, Grep, Glob" preset — the user has to approve each distinct tool once, then "Allow always" sticks it.

- **Files**: `packages/shared/src/index.ts` (permission types + new WS event types), `packages/backend/src/db/schema.ts`, `packages/backend/src/db/migrations/0007_env_tool_allowlist.sql` (new), `packages/backend/src/db/migrations/meta/0007_snapshot.json` (new), `packages/backend/src/services/permissionService.ts` (new), `packages/backend/src/services/permissionHook.ts` (new), `packages/backend/src/services/agentStructured.ts`, `packages/backend/src/services/agent.ts`, `packages/backend/src/services/environment.ts`, `packages/backend/src/services/websocket.ts`, `packages/backend/src/routes/permission.ts` (new), `packages/backend/src/routes/environments.ts`, `packages/backend/src/routes/index.ts`, `packages/backend/src/__tests__/permissionService.test.ts` (new), `apps/desktop/src/renderer/components/terminal/AgentConversation.tsx` (new), `apps/desktop/src/renderer/components/terminal/StructuredTranscript.tsx` (deleted), `apps/desktop/src/renderer/components/panels/TaskTerminal.tsx`, `apps/desktop/src/renderer/components/panels/TerminalHistory.tsx`, `apps/desktop/src/renderer/lib/api.ts`.

## Session 18 (structured-renderer Slice 1 — stream-json plumbing)
Start of the move from raw-PTY CLI output to a structured conversation renderer. The original plan was to swap the `claude` CLI for `@anthropic-ai/claude-agent-sdk`, but research + a spike showed the SDK is API-key-only by policy — Claude Pro/Max subscription auth is explicitly unsupported, so migrating would force every existing user onto metered API billing. Path C instead: keep spawning the `claude` binary (so OAuth subscription auth continues to work) but switch to `--output-format stream-json --verbose --include-partial-messages`, which emits the same structured events the SDK does. All three planned phases (A autonomous-strict, B autonomous-bypass, C interactive) land on this shared foundation.

- **Spike findings** (documented before coding):
  - `claude -p --output-format stream-json --verbose` emits JSONL for `system` / `assistant` / `user` / `stream_event` / `result` — content blocks include `text`, `thinking`, `tool_use`, `tool_result`. Init event shows `apiKeySource: "none"` confirming OAuth creds from `~/.claude/` are honored.
  - `--include-partial-messages` adds `content_block_delta` events (chunky but usable text streaming).
  - `PreToolUse` hooks configured via `--settings '<inline-json>'` synchronously gate tool use — our eventual permission-callback path for Slice 2.
  - Inline `--settings` JSON works, so no temp-file-per-spawn plumbing needed.

- **Shared types** (`packages/shared/src/index.ts`): `Environment.renderer: 'pty' | 'structured'` + new `EnvironmentRenderer`. `Task.transcript?: AgentEvent[]`. `AgentEvent` defined permissively (mirrors the CLI's own schema — `type`, optional `subtype`, `message`, `event`, `result`, etc., plus our own `seq: number` for ordering). Two new WS event types: `agent:event` and `task:event` with `AgentEventBroadcast` / `TaskEventBroadcast` payloads.

- **DB migration** (`0006_structured_renderer.sql`): `environments.renderer` (text, default `'pty'`), `tasks.transcript` (jsonb nullable). Fresh installs default to `'pty'` — no behavioural change for existing envs/tasks.

- **New service** (`packages/backend/src/services/agentStructured.ts`, ~230 LOC):
  - `AgentStructuredService.start(opts)` non-PTY-spawns `claude` with the stream-json argv, writes the prompt on stdin, and parses stdout line by line via `JsonlLineParser`.
  - Each parsed event gets a monotonic `seq` stamp, appended to an in-memory transcript, broadcast as `agent:event` + `task:event`, and persisted to `tasks.transcript` every 25 events (and unconditionally on `type === 'result'`).
  - Transcripts are capped at `TRANSCRIPT_MAX_EVENTS = 2000`: above the cap, the middle drops out with a `{type: 'system', subtype: 'truncated'}` marker. Prevents one unruly autonomous task from nuking the jsonb column.
  - `stop()` kills the child with SIGTERM; the `completion` promise resolves with whatever exit code the child produces.
  - Stderr from the child is surfaced as synthetic `system/stderr` events so the UI can render CLI misbehaviour.

- **Dispatcher** (`packages/backend/src/services/agent.ts`): `startAgent` checks `env.renderer === 'structured' && env.type === 'local' && autonomous && prompt` — if true, calls the new `startStructuredAgent` path; otherwise the existing PTY path. The structured path inserts the same `agents` / `tasks` rows (so inbox, task list, stop endpoint all keep working uniformly), writes `task.metadata.runtime = 'structured'` so the UI can pick the right renderer, and maps exit code onto the existing `awaiting_review` / `failed` rules via a new `handleStructuredExit`. `stopAgent` routes to `agentStructuredService.stop()` for structured sessions and the existing PTY kill for everyone else.

- **Routes** (`packages/backend/src/routes/environments.ts`): `POST /environments` accepts optional `renderer` on create (defaults to `'pty'`, silently falls back to `'pty'` for non-local envs in Slice 1). `PATCH /environments/:id` honors `renderer` updates with the same guard. Both echo `renderer` in responses. `GET /tasks/:id/terminal` now returns `{ terminalOutput, transcript, runtime }` so callers can pick the right renderer.

- **WS helpers** (`packages/backend/src/services/websocket.ts`): `emitAgentEvent` + `emitTaskEvent` broadcast structured events to workspace subscribers.

- **Desktop**:
  - New `apps/desktop/src/renderer/components/terminal/StructuredTranscript.tsx` (interim Slice-1 renderer): one line per event, colour-coded by type, with a one-line summary (text snippet, `→ tool(args)`, `← ok/err`, cost for `result`). Replaced by Slice 2's `AgentConversation.tsx`.
  - `TaskTerminal.tsx` branches on `task.metadata.runtime === 'structured'` — renders `StructuredTranscript` instead of `XTerm`.
  - `TerminalHistory.tsx` rewritten to fetch `{ terminalOutput, transcript, runtime }` and pick the renderer per-task.
  - `useApi.ts` subscribes to `task:event`, dedups by `seq`, maintains a sorted transcript on the task store entry.

- **Tests**: 12 new unit tests in `agentStructured.test.ts` covering the JSONL parser (partial-line buffering, multi-chunk assembly, blank-line handling, malformed-line tolerance) + `buildClaudeArgs` (bypass mode flag, stream-json defaults, session-persistence disabled). Full suite: **101 tests passing** in ~27s. The end-to-end spawn path is easiest to validate by hand with a running backend — no fake-CLI fixture yet.

- **Deliberate scope boundaries for Slice 1**:
  - Only wired for `autonomous && prompt` tasks on `local` envs. Interactive user-initiated tasks + SSH/daemon envs stay on the existing PTY path until Slice 2/3 and a daemon-side follow-up.
  - Bypass-permissions only. Per-tool Approve/Deny UI comes in Slice 2 via a `PreToolUse` hook invoking an in-process FastOwl endpoint.
  - Interim renderer is deliberately ugly — validates plumbing; Slice 2 builds the markdown + collapsible-tool-call conversation UI.
  - No back-migration of historical `terminal_output` — legacy PTY tasks keep rendering via XTerm forever; the runtime field is sticky per task.

- **Files**: `packages/shared/src/index.ts`, `packages/backend/src/db/schema.ts`, `packages/backend/src/db/migrations/0006_structured_renderer.sql` (new), `packages/backend/src/db/migrations/meta/0006_snapshot.json` (new, regenerated journal), `packages/backend/src/services/agentStructured.ts` (new), `packages/backend/src/services/agent.ts`, `packages/backend/src/services/environment.ts`, `packages/backend/src/services/websocket.ts`, `packages/backend/src/routes/environments.ts`, `packages/backend/src/routes/tasks.ts`, `packages/backend/src/__tests__/agentStructured.test.ts` (new), `apps/desktop/src/renderer/components/terminal/StructuredTranscript.tsx` (new), `apps/desktop/src/renderer/components/panels/TaskTerminal.tsx`, `apps/desktop/src/renderer/components/panels/TerminalHistory.tsx`, `apps/desktop/src/renderer/hooks/useApi.ts`, `apps/desktop/src/renderer/lib/api.ts`.

## Session 17 (failure-cascade hardening — scheduler backoff + stuck-task recovery)
Pass over the Continuous Build scheduler + task queue to close the "runs unattended overnight" part of the DoD. Three cascades fixed: deterministic-failure infinite loop, ghost tasks that never recover from a silent agent death, and the markdown-sync-clobbers-running-task case.

- **Failure counter + backoff + auto-block** (`services/continuousBuild.ts` + `services/backlog/service.ts`):
  - New columns on `backlog_items`: `consecutive_failures` (int, default 0) + `last_failure_at` (timestamptz, nullable). Migration `0004_backlog_failure_tracking.sql`.
  - Scheduler's `onTaskStatus` now distinguishes `failed` (counts as a failure, bumps counter + stamps time) from `cancelled` (user-initiated, doesn't count). Completed/approved resets the counter to 0.
  - Backoff schedule: 1m → 5m → 15m → 60m by failure count. `nextActionableItem` filters on `lastFailureAt <= cutoff` and the scheduler re-checks the backoff window for the candidate. A looping broken TODO can't hog the queue anymore.
  - After 5 consecutive failures the item flips to `blocked`. Human has to fix whatever's deterministically wrong, then unblock it in the UI.
- **Periodic stuck-task recovery** (`services/taskQueue.ts`): `recoverStuckTasks` used to run only at `init()`. Now also runs every 2 minutes on a timer, and the query picks up an extra case — tasks whose `updated_at` hasn't moved in 20 minutes (proxy for "agent silently dropped"). Covers daemon disconnects mid-task, hung processes, etc. — previously those required a service restart to clear.
- **Guard claimed items against sync auto-completion** (`services/backlog/service.ts`): when a backlog item disappears from the markdown source, `syncSource` auto-marks it completed — but only if it's **not currently claimed**. Previously a running task could have its item silently marked complete by a concurrent markdown edit, orphaning the task's work.
- **Tests** (+7 total): 5 scheduler tests (failure → counter bump, backoff window, 5th failure blocks, cancelled doesn't count, complete clears counter, sync-with-claim is no-op), 1 taskQueue test (time-based staleness recovery), 1 backlog test (claim survives sync-side-delete). Full suite stays fast — 74+6 = 80 tests in ~11s.

- **Why these three and not others from the failure-path audit**: the audit (via explore subagent) turned up more — orphaned git branches, fire-and-forget promise paths in agent status updates, approval-reject flow — but these three were the direct blockers for "unattended overnight": an infinite loop is catastrophic, a stuck task needs periodic rescue, and a sync-race is a silent data-loss bug. The others are quality-of-life and can land when they land.

- **Schema note**: `BacklogItem` gains two fields in `@fastowl/shared` — `consecutiveFailures: number` + `lastFailureAt?: string`. Renderer components that destructure backlog items keep working (new fields are additive); the UI doesn't render them yet, but they're available for a future "this item has failed N times" badge.

- **Files**: `packages/backend/src/services/continuousBuild.ts`, `packages/backend/src/services/backlog/service.ts`, `packages/backend/src/services/taskQueue.ts`, `packages/backend/src/db/schema.ts`, `packages/backend/src/db/migrations/0004_backlog_failure_tracking.sql` (new), `packages/shared/src/index.ts`, tests across three files.

## Session 17 (test hang fix — daemonRegistry fire-and-forget UPDATE race)
CI (and local `npm test`) had been timing out in `daemonRegistry.test.ts`. Diagnosed as a race between `markEnvConnected` (fired by `register()`) and `markEnvDisconnected` (fired by `unregister()`) — both are fire-and-forget `.update()` calls on the same environment row. Under pglite (the test harness), running two unawaited UPDATEs on the same row concurrently **pins the worker at 100% CPU** inside pglite's WASM scheduler. Bisected down from the whole file → to the fourth test ("disconnecting a daemon rejects its in-flight requests") — the one case that exercises both register+unregister inline — and traced it to a hang at `pglite.waitReady` in the *next* test's `beforeEach` (WASM init starves once the previous test leaves pending in-flight queries behind).

- **Fix**: introduced a private `dbTail: Promise<void>` in `daemonRegistry` that serializes every env-status flip. `markEnvConnected` and `markEnvDisconnected` now `.then()`-append onto `dbTail` so writes happen in order, never concurrently for the same row. Added `flushPending()` and made `shutdown()` `async` + await `flushPending()` so tests cleanly drain before pglite closes.
- **Callers updated**: `packages/backend/src/index.ts` SIGTERM handler + `daemonRegistry.test.ts` afterEach now `await daemonRegistry.shutdown()`.
- **Result**: full backend suite goes from timing out to **74/74 passed in 11.6s**. `daemonRegistry.test.ts` on its own: 5/5 in 4s.
- **Why the race didn't show up on real Postgres**: a real connection supports multiple concurrent statements; pglite serializes through a single WASM instance and the fire-and-forget pattern leaves the worker's microtask queue clogged when the following test tries to spin up a fresh pglite. Production (Supabase) was fine.
- **Files**: `packages/backend/src/services/daemonRegistry.ts`, `packages/backend/src/index.ts`, `packages/backend/src/__tests__/daemonRegistry.test.ts`.

## Session 17 (Phase 18.3.B — SSH auto-install of the daemon)
The "give me SSH creds and I'll do the rest" path. Desktop's Add Environment dialog now has a **Remote VM (FastOwl daemon)** type with two modes: **auto-install over SSH** (backend SSHes in and runs a hosted install script) or **manual** (shows a copy-paste one-liner). Either way, a daemon env is created, a pairing token is minted, and the env flips to `connected` as soon as the daemon dials back — no user JWT ever touches the VM.

- **Shared types**: added `DaemonEnvironmentConfig` (`type: 'daemon'`, `hostname?`, `workingDirectory?`) to the `EnvironmentConfig` union + `InstallDaemonOverSshRequest`/`Response`. Keeps the Environment type honest now that daemon envs are first-class.
- **`scripts/install-daemon.sh`** (new): OS-aware provisioning script served via the backend. Installs Node 22 (NodeSource on Debian/Ubuntu, yum-nodesource on RHEL, `brew` on macOS, nvm fallback), installs `build-essential` + `python3` on Linux for node-pty, clones `Gilbert09/owl`, builds `@fastowl/shared` + `@fastowl/daemon`, runs the daemon once in foreground with `--pairing-token` to exchange for a device token (watches the on-disk config file for `deviceToken` to appear, times out at 60s), then writes a systemd unit at `/etc/systemd/system/fastowl-daemon.service` (Linux) or a launchd plist at `~/Library/LaunchAgents/dev.fastowl.daemon.plist` (darwin). Idempotent — safe to re-run.
- **Backend public route** (`routes/daemon.ts`): `GET /daemon/install.sh` serves the script. Unauthenticated by design — the credential is the pairing token, not the HTTP request. Dockerfile now `COPY scripts ./scripts` so the script is on disk at runtime.
- **Backend SSH installer** (`services/daemonInstaller.ts`): uses ssh2 to dial the target, supports `password` + `privateKey` auth (raw PEM content, not file paths — the private key gets pasted into the desktop UI and is used once per install), exec's `curl -fsSL <backend>/daemon/install.sh | bash -s -- --backend-url ... --pairing-token ...`, captures stdout+stderr, returns the log. 5-minute timeout.
- **Backend route**: `POST /api/v1/environments/:id/install-daemon` — owner-scoped, validates env type is `daemon`, mints a fresh pairing token on every call, resolves the backend URL from `FASTOWL_PUBLIC_BACKEND_URL` env var (falls back to `req.protocol://req.host`), hands off to `installDaemonOverSsh`. Returns `{ success, log, exitCode, backendUrl }`.
- **Desktop UI** (`AddEnvironmentModal.tsx`): rewritten around three types. "Remote VM (FastOwl daemon)" is the new default for cloud-backend users; "SSH (legacy)" is kept behind a warning for local-backend users. In daemon/ssh-install mode: host/port/user + (password | pasted PEM key + optional passphrase). In daemon/manual mode: after creation, shows the copy-paste one-liner with a Copy button. Either way, after submit, the modal polls `GET /environments/:id` every 3s and flips to "Daemon connected!" when the backend sees the daemon dial back.
- **Docs**: Roadmap 18.3 flipped to `[x]` for remote install; single-file binary is deferred (git-clone install works end-to-end). Priority queue now has 17.3 (notifications) at the top.

- **Design decisions**:
  - **Git clone, not a prebuilt binary** — the MVP install path shells out to `git clone` + `npm install` + `npm run build` rather than shipping a prebuilt tarball. Reasons: `node-pty` is a native module, and cross-compiling a binary that works on linux/amd64 + linux/arm64 + darwin/arm64 adds a whole CI pipeline. The git-clone path uses whatever Node is on the target, builds native modules in place, and avoids a new release surface. Downside: first install on a VM takes ~2 minutes instead of ~10 seconds. Acceptable for now.
  - **Pasted PEM instead of key file** — the hosted backend can't read the user's `~/.ssh/id_rsa`. The install endpoint accepts the private key contents in the request body, uses it for a single ssh2 connection, and never stores it. Memory-only, dies with the request. Same principle as the install-script one-liner: the credential exists in the path of the install and nowhere else.
  - **One pairing token per install call** — every `POST /install-daemon` invocation mints a fresh token (even for the same env). Avoids the "pairing token reuse" failure mode if the previous install timed out or was interrupted. Tokens expire in 10min anyway, so there's no cleanup debt.
  - **Polling instead of WebSocket for "daemon connected"** — the modal polls the env's status every 3s. Could push an `environment:status` WS event (we already emit them), but the modal is short-lived enough that polling is simpler than hooking into the store and filtering.

- **Still to land (deferred)**:
  - Symmetric uninstall flow (delete env → SSH in → systemctl disable + rm). Not critical.
  - Prebuilt daemon binary (`bun --compile`) — avoids the ~2min first-install npm install step. Nice-to-have.
  - Wire-up streaming install logs to the modal via WS (today we only show the log after the install finishes). UX nit.
  - End-to-end test of the install flow against a real VM. Covered manually; no CI yet.

- **Files touched**: `packages/shared/src/index.ts` (DaemonEnvironmentConfig + install API types); `scripts/install-daemon.sh` (new); `packages/backend/src/routes/daemon.ts` (new); `packages/backend/src/routes/index.ts` (mount `/daemon`); `packages/backend/src/services/daemonInstaller.ts` (new); `packages/backend/src/routes/environments.ts` (install-daemon endpoint); `Dockerfile` (COPY scripts); `apps/desktop/src/renderer/lib/api.ts` (pairingToken + installDaemon helpers); `apps/desktop/src/renderer/components/modals/AddEnvironmentModal.tsx` (rewritten).

- **How to exercise it locally**:
  1. `npm run dev -w @fastowl/backend` (local backend on 4747)
  2. Open desktop, Settings → Environments → Add
  3. Pick **Remote VM (FastOwl daemon)** → **Show me the install command** (the SSH path requires a real VM)
  4. Name it, Generate → copy the one-liner
  5. On any VM: paste the command (it'll curl from `http://localhost:4747/daemon/install.sh` which only works from the same network; for a real test, set `FASTOWL_PUBLIC_BACKEND_URL` to the hosted URL)
  6. Modal flips to "Daemon connected!" when the daemon dials back.

- **Next action**: **Phase 18.2 polish** (proper `fastowl login` PKCE + CLI refresh-token rotation + cross-user HTTP-layer integration test) or **Phase 18.3 polish** (single-file daemon binary via `bun --compile`).

### Phase 17.3 landed in the same session

Desktop OS notification fires when any task transitions into `awaiting_review`. Implementation is surprisingly small — the renderer already subscribes to `task:status` events; added a pre-update status check to detect the transition (to avoid firing on idempotent restates), then `new Notification(...)` in the granted-permission path. Electron bridges the renderer-side `Notification` constructor to the native OS surface — no preload work, no main-process IPC.

- **Preference**: stored in `localStorage` under `fastowl:notify:awaitingReview`. Default on. Toggled from Settings → Appearance → Notifications.
- **Permission**: requested lazily on first-eligible event. Settings toggle also requests eagerly on flip-to-on so the permission prompt doesn't race with the actual event. When the OS-level permission is denied, the settings panel surfaces a "Notifications are blocked at the OS level" hint.
- **Click-through**: `n.onclick = () => window.focus()` brings the app forward. Could later deep-link to the specific task (route + select) but the inbox + queue are both visible on the main screen.
- **Transition semantics**: we grab the previous task from the store BEFORE applying the update, so `wasAwaitingReview` reflects the prior state. If a WS event arrives that re-states `awaiting_review` without a transition (recovery path, duplicate event), no notification fires.
- **Files**: `apps/desktop/src/renderer/hooks/useApi.ts` (new `maybeNotifyAwaitingReview` + pref helpers); `apps/desktop/src/renderer/components/panels/SettingsPanel.tsx` (Notifications card in AppearanceSettings); `docs/ROADMAP.md` + `CLAUDE.md` + this note.
- **Deferred**: per-task-type toggles, digest mode, click-through that deep-links to the task. None block the "production ready" goal.

## Session 16 (Phase 18.3.B foundation — daemon relay layer)
Option-1 relay shipped. Child processes spawned by a daemon (`claude` running a task, `fastowl` CLI calls from within that Claude, any MCP server) now reach the backend through a local HTTP proxy on the daemon, which tunnels each request over the daemon's authenticated WS. No user JWT ever lives on the VM.

- **Protocol**: added `ProxyHttpRequest` / `ProxyHttpResult` to the daemon↔backend wire. Request is { method, path, headers, body (base64) } — full REST round-trip, not a typed RPC surface. Keeps every existing route available to daemon children without duplicating the API.
- **Backend auth refactor**: `requireAuth` now accepts two credential paths. Path 1 (existing): `Authorization: Bearer <Supabase JWT>`. Path 2 (new): `X-Fastowl-Internal-User: <uuid>` + `X-Fastowl-Internal-Token: <secret>`. The secret is minted once at process boot with `randomBytes(48)` and held only in memory — reboot rotates it. Comparison is `timingSafeEqual`. Internal requests resolve the user from the `users` table directly, skipping the Supabase round-trip.
- **Backend proxy dispatcher** (`services/daemonProxyHandler.ts`): when a daemon sends `proxy_http_request` on its WS, backend looks up `env.owner_id`, makes a localhost `fetch` against `http://127.0.0.1:${PORT}${path}` with `internalProxyHeaders(ownerId)`, and ships the response back in a `proxy_http_response`. Drops `authorization`, `cookie`, `host`, and hop-by-hop headers from the inbound side; drops `content-length` / `transfer-encoding` from the outbound response (daemon recomputes).
- **Daemon proxy server** (`proxyServer.ts`): HTTP server bound to `127.0.0.1:0` (random port). Every inbound request is serialized into `proxy_http_request`, sent over the WS, and awaited up to 60s. On daemon start, `FASTOWL_API_URL=http://127.0.0.1:<port>` is set as a child-env override; `FASTOWL_AUTH_TOKEN` is always scrubbed from the spawn env so a stale user token can't leak through.
- **Daemon WS client**: now sends daemon→backend `request` messages (previously only events). Tracks its own `pendingProxyRequests` map with 60s timeouts; rejects them all on shutdown.
- **Tests**: `daemonProxy.test.ts` mounts `requireAuth` on a minimal Express app and exercises the internal-header path — valid user, wrong token, unknown user. All four pass; full backend suite is 74/74.

- **Still to land in 18.3.B**:
  - Rewire scheduler / taskQueue so tasks actually execute on `daemon` envs end-to-end (today they still prefer legacy `local`/`ssh`).
  - `fastowl-daemon install` + server-hosted `install.sh` + tarball publication (probably from Railway `/daemon/latest.tar.gz` for MVP).
  - Desktop "Add SSH environment → Install FastOwl daemon" checkbox that SSHes in, runs the install, polls for the daemon to dial back.
  - Ownership propagation: provisioning an env + dispatching a proxy request both hinge on `env.owner_id`; need a regression test that covers user-A-VM cannot proxy as user-B.

- **How to exercise the relay today**:
  1. `npm run dev -w @fastowl/backend`
  2. Create a daemon env + pairing token via REST (auth'd with your CLI token as before).
  3. `node packages/daemon/dist/index.js --pairing-token <x> --backend-url http://localhost:4747`
  4. Daemon logs `listening on http://127.0.0.1:<port>`.
  5. From the shell where the daemon is running: `FASTOWL_API_URL=http://127.0.0.1:<port> FASTOWL_AUTH_TOKEN= fastowl workspace list` — request hits the local proxy, tunnels over WS, backend answers as the daemon's owner.

- **Follow-up commits landed same session**:
  - `a0000ea` Daemon envs are first-class in scheduling: daemonRegistry updates `environments.status` on register/unregister; `backlogService` and `continuousBuildScheduler` fall back to any connected daemon when no env is pinned; `connectSavedEnvironments` on startup marks daemon envs disconnected until they dial back.
  - `9e82bc7` CI hygiene: `@fastowl/daemon` gets `--passWithNoTests` so an empty suite doesn't fail CI; `taskQueueService` gains a `shuttingDown` flag + `runProcessQueue` wrapper that swallows the "DATABASE_URL is not set" noise triggered by floating promises after a test's DB reset; AuthProvider no longer `console.error`s when Supabase env vars are missing (LoginScreen already surfaces a visible warning).

## Session 15 (Phase 18.3.A — daemon package + WS transport)
Foundation for the SSH auto-install flow. Daemon package exists and can dial the hosted backend; backend has a `/daemon-ws` endpoint, a registry that tracks live daemons, and a `daemon` env type that proxies commands through. No UX change yet — Phase 18.3.B bolts the "Install daemon" checkbox onto the Add-SSH-env dialog.

- **Wire protocol** in `@fastowl/shared/daemonProtocol.ts`: JSON-framed WS envelopes with `hello` / `hello_ack` / `request` / `response` / `event`. Correlation IDs on request/response. Close codes in the 4xxx range for a daemon to log a clear reason (4401 unauthorized, 4409 duplicate, 4500 server shutdown). Encoded as `JSON.stringify(envelope)` so the same types also work over stdio if we ever need a local test daemon.
- **`packages/daemon`** (new workspace): `executor.ts` wraps `child_process.spawn` + `node-pty`, `git.ts` mirrors backend `gitService` via exec, `wsClient.ts` handles the dial/hello/reconnect loop (exponential backoff capped at 30 s), `config.ts` resolves CLI args / env vars / `~/.fastowl/daemon.json` with that precedence. Bin is `fastowl-daemon`.
- **Schema**: `environments` gets `device_token_hash` (SHA-256 of the long-lived daemon token) and `last_seen_at`, plus a new env type `daemon`. Migration 0003. `0002_snapshot.json` got re-ided because Stage 5's manual copy had a duplicate id that collided with drizzle-kit on regen.
- **Backend**:
  - `services/daemonRegistry.ts` owns pairings (in-memory, 10 min TTL) and live daemon connections. Mints device tokens, matches them on reconnect, issues requests with 30 s timeouts, routes responses by correlation id, forwards events as `session.data` / `session.close` / `status` EventEmitter events. No background timers — pairing expiry is swept inline on each `authenticate` call so tests don't have to deal with open timer handles.
  - `services/daemonWs.ts` accepts connections at `/daemon-ws`, enforces a 5-second hello timeout, hands auth off to the registry, then routes subsequent messages.
  - `services/environment.ts` gained `case 'daemon':` branches for `connect`, `exec`, `spawnInteractive`, `writeToSession`, `killSession`, `getStatus`. Sub-daemon events flow back through the existing `session:data` / `session:close` EventEmitter the rest of the backend already listens for.
  - `index.ts`: separate `WebSocketServer({ noServer: true })` for daemon upgrades, path-dispatched on the HTTP `upgrade` event so the existing `/ws` keeps its own handler.
  - `routes/environments.ts`: new `POST /:id/pairing-token` mints a one-shot pairing token for a daemon env. Validates ownership + env type. 10-minute TTL.
- **Tests**: `daemonRegistry.test.ts` covers pairing-then-device handshake, reconnect-with-device-token, request/response round-trip, in-flight rejection on disconnect, and event forwarding. Uses a `FakeWs` EventEmitter stand-in so no sockets or network. 70/70 green.

- **Deliberately deferred to follow-ups**:
  - Bundled daemon spawn from Electron main — the user has to run the daemon manually (CLI) for now. Next: desktop spawns daemon as a child process on app start, creates a local daemon env, pairs automatically.
  - Liveness heartbeat (periodic `last_seen_at` stamp while connected) — today it's set on register only.
  - UI to create a daemon env + show the `fastowl-daemon --pairing-token X --backend-url Y` command.
  - Legacy `local` / `ssh` env types still exist and still work when the backend runs on the user's laptop; only the `daemon` type works against the hosted backend.

- **How to try it locally** (dev loop):
  1. Point desktop at local backend: `FASTOWL_API_URL=http://localhost:4747` in `apps/desktop/.env`, rebuild.
  2. Start the backend (`npm run dev -w @fastowl/backend`).
  3. Create a daemon env via API: `POST /api/v1/environments` with `{ "type": "daemon", "name": "My Mac", "config": {} }` (requires bearer token from desktop login → Copy CLI token).
  4. Mint a pairing token: `POST /api/v1/environments/:id/pairing-token`.
  5. Run the daemon: `node packages/daemon/dist/index.js --pairing-token <token> --backend-url http://localhost:4747`.
  6. Watch it pair, write `~/.fastowl/daemon.json`, stay connected. Restart with no args and it reconnects using the stored device token.

- **Next action (Phase 18.3.B)**: "Add SSH environment → Install FastOwl daemon" checkbox in the desktop dialog. Backend SSHes in, runs a server-hosted `install.sh`, writes a systemd/launchd unit, starts the service. At that point: one click to onboard a VM.

## Session 14 (Phase 18.4 — backend on Railway)
Backend now live at `https://fastowl-backend-production.up.railway.app`. Health check passes, migrations ran on startup, RLS confirmed on every user-scoped table. Desktop `.env` flipped to point at Railway.

- **Dockerfile** (multi-stage): builder installs the whole workspace + compiles with tsc + prunes to prod deps; runtime copies `node_modules` + `dist/` + migrations. Copying node_modules instead of reinstalling keeps `node-pty` / `ssh2` native bindings intact without needing build tools in the runtime image. `.dockerignore` keeps the build context tight (no desktop release, no .env, no docs).
- **Migrations fix**: `tsc` doesn't copy `.sql` files, so the migrate-on-startup would have crashed in prod. Added `build:copy-migrations` postbuild script (`fs.cpSync` — ESM-safe, no shell) that mirrors `src/db/migrations` → `dist/db/migrations`.
- **railway.toml**: DOCKERFILE builder, healthcheck at `/health` (30s window), restart on failure max 5 retries.
- **CI**: `.github/workflows/deploy-backend.yml` deploys on pushes to main that touch backend/shared/Dockerfile, using `RAILWAY_TOKEN` secret. Path-filtered so desktop-only changes don't redeploy.
- **Two gotchas that bit**:
  1. Railway doesn't route IPv6; Supabase's direct `db.<ref>.supabase.co` resolves IPv6. Fix: use the transaction pooler (`aws-1-eu-west-2.pooler.supabase.com:6543`). Session 12 had the wrong region prefix (`aws-0-` vs `aws-1-` — it's project-specific, copy from the dashboard).
  2. `--ignore-scripts` on `npm ci` in the runtime stage strips node-pty's native binary. Moved the install to the builder stage and copied the resulting `node_modules` across — works without shipping python/build-essential to the runtime image.
- **Env vars on Railway** (service `fastowl-backend`): `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FASTOWL_ALLOWED_EMAILS=owerstom@googlemail.com`, `NODE_ENV=production`. `PORT` auto-provided by Railway.
- **Desktop**: `apps/desktop/.env` gains `FASTOWL_API_URL=https://fastowl-backend-production.up.railway.app`. Commented fallback to `http://localhost:4747` for running against a local backend.
- **Verified**: `GET /health` returns the full service payload; `GET /api/v1/workspaces` without auth returns 401 (middleware enforcing); Supabase query confirms RLS is on for all 10 user-scoped tables, off for `settings`.

- **Still outstanding**:
  - Add `RAILWAY_TOKEN` to GitHub repo secrets (manual; required before the deploy workflow actually runs).
  - Update workspace-integration GitHub OAuth app callback URL if/when we exercise it against the hosted backend.
  - Extra Railway "FastOwl" service auto-created alongside `fastowl-backend` can be deleted via the dashboard — harmless but cluttered.

- **Next action**: **Phase 18.3 — daemon split + SSH auto-install.** With the backend hosted, a VM now has a target to dial out to. Extract env/agent/git services into `packages/daemon`, flip the connection direction, add the "Install FastOwl daemon" checkbox in the Add-SSH-env dialog.

## Session 13 (Phase 18.2 — end-to-end auth)
Wired Supabase GitHub OAuth through backend, desktop, CLI, and MCP in five focused commits. Every REST endpoint and the WebSocket upgrade now require a valid Supabase JWT; data is scoped by `owner_id` at the app layer with RLS as defense in depth.

- **Schema + routes** (`b267d0f`): added `users` table mirroring `auth.users`, added `owner_id` (NOT NULL, FK) on `workspaces` + `environments` — everything else inherits access through its workspace FK. `requireAuth` middleware verifies Supabase JWTs via `auth.getUser(token)`, upserts the user row on first sight, and enforces `FASTOWL_ALLOWED_EMAILS` if set. Every route got ownership gates (helper: `requireWorkspaceAccess`, `requireTaskAccess`, etc.). `/api/v1/github/callback` stays public — state-token lookup guards it. WebSocket accepts `?token=` on upgrade, verifies, then scopes subscribe requests to the connected user's workspaces.
- **Desktop login** (`3790764`): `AuthProvider` wraps the app. Sign-in opens GitHub OAuth in the system browser via `shell.openExternal`, Supabase redirects to `fastowl://auth-callback#access_token=...`, the main process catches the deep link and forwards over IPC. `api.ts` attaches `Authorization: Bearer` to every REST call and the WS upgrade query. Added `fastowl://` to the `protocols` field in `package.json` for packaged builds.
- **CLI + MCP** (`4591c7a`): CLI reads token from `~/.fastowl/token` (mode 0600) or `FASTOWL_AUTH_TOKEN`; new `fastowl token set|show|clear|whoami` commands. MCP is env-only (parent agent sets `FASTOWL_AUTH_TOKEN` on spawn). Desktop Settings gains an Account tab with sign-out and a one-click "Copy CLI token" button — tokens expire hourly so users re-copy as needed. Proper PKCE `fastowl login` deferred.
- **RLS** (`4a9cdd6`): migration enables RLS on all user-scoped tables + policies on `auth.uid()`. Test helper stubs `auth.uid()` so pglite can apply the migration; pglite's superuser connection bypasses RLS the same way the service role does in prod.
- **Docs**: this session note + SETUP.md (Supabase redirect URL, allow-list env var, desktop/CLI env conventions).

- **Key decisions** (ratified with Tom):
  - Ownership lives only on top-level tables (`workspaces`, `environments`) + `users`. Child tables (tasks, agents, inbox, repos, integrations, backlog_sources, backlog_items) cascade access through the workspace FK. Simpler schema, simpler RLS, matches existing mental model.
  - Backend uses the service-role key + app-level owner filtering. Keeps Drizzle usage unchanged; no per-request Supabase client.
  - Electron OAuth = system browser + `fastowl://` deep link. Rejected embedded BrowserWindow (less secure, non-standard).
  - Allow-list env var for single-user mode; invite flow explicitly deferred (documented as TODO in ROADMAP 12.7).

- **Still on the list**:
  - Proper `fastowl login` with PKCE code flow + local callback server (replaces copy-paste token UX).
  - Refresh-token rotation in CLI (right now CLI tokens expire in an hour, user re-copies).
  - Cross-user integration test at the HTTP layer (today's coverage is: migration applies RLS, app-level helpers are structured around owner checks, but we don't spin up two users and assert user A's routes 404 on user B's resources).
  - Invite flow + `workspaces_users` join table once FastOwl needs real multi-tenancy.

- **Files touched**: schema + 2 new migrations; new `middleware/auth.ts` + `services/supabase.ts`; all 8 route files gated; new `renderer/components/auth/{AuthProvider,LoginScreen}.tsx` + `renderer/lib/supabase.ts`; `main/main.ts` + `preload.ts` for deep-link plumbing; CLI `commands/token.ts` + `config.ts`; MCP `client.ts`; Settings panel Account section.

- **Next action**: continue Phase 18.3 (daemon split + auto-install over SSH) or 17.3 (notifications). Auth is done enough to build on top of.

## Session 12 (Hosted backend — Phase A + B landed, Phase C ready to resume)
Started the hosted-backend work from `docs/CONTINUOUS_BUILD_ROADMAP.md`. Phases A + B complete end-to-end on hosted infra. Phase C started then paused to avoid a half-broken main; picks up next session from a known-green state.

- **Phase A (COMPLETED)** — Drizzle ORM scaffolding:
  - `packages/backend/src/db/schema.ts` — Drizzle schema with all 10 tables (workspaces, repositories, integrations, environments, tasks, agents, inboxItems, settings, backlogSources, backlogItems). Upgraded types for Postgres: `jsonb` for structured payloads (settings, config, metadata, result, actions, source, data), `timestamp with time zone` for dates, `boolean` for flags (no more 0/1 ints).
  - `packages/backend/src/db/client.ts` — wraps postgres-js + drizzle-orm, exposes `getDbClient()` singleton + `setDbClient()`/`resetDbClient()` test hooks. Exports `Database` type alias (the Drizzle query builder) that services will consume in Phase C.
  - `packages/backend/drizzle.config.ts` — points schema → `src/db/migrations/`, dialect postgresql, casing snake_case.
  - `packages/backend/src/db/migrations/0000_initial.sql` — generated by `npx drizzle-kit generate --name initial`. 152 lines. This is the target state of the hosted DB; hand-rolled SQLite migrations 001-007 are being retired.
  - Scripts on backend `package.json`: `db:generate`, `db:migrate`, `db:studio`.
  - Deps added: `drizzle-orm@^0.45.2`, `postgres@^3.4.9`, `drizzle-kit@^0.31.10` (dev), `@electric-sql/pglite@^0.4.4` (dev, intended for Phase C tests).
  - `skipLibCheck: true` on `packages/backend/tsconfig.json` (drizzle-orm/sqlite-core ships types that trip strict checks — harmless since we don't use that module).

- **Phase B (COMPLETED)** — Supabase project provisioned via MCP:
  - Organization: `nmgucldojryyubpdxdfg` ("FastOwl")
  - Project: **`fastowl-prod`** — id `xodyzfwlwvgzezwlkrqn`, region `eu-west-2`, status `ACTIVE_HEALTHY`, cost $0/mo
  - Project URL: `https://xodyzfwlwvgzezwlkrqn.supabase.co`
  - All 10 tables live with 0 rows. **RLS is intentionally off** — Phase E turns it on when auth lands.
  - Publishable API keys:
    - anon (legacy JWT) — `eyJhbGciOiJIUzI1NiIs...` (truncated here; full token in Supabase dashboard + MCP)
    - default publishable — `sb_publishable_g6uFDJjjiMG9DNDB9wt_Rg_KsB2nutR`
  - Postgres connection string lives in `packages/backend/.env` as `DATABASE_URL` (format: `postgresql://postgres.xodyzfwlwvgzezwlkrqn:[password]@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`). `.env` is gitignored.

- **Phase C (STARTED, REVERTED, RESUMES NEXT SESSION)** — services rewrite to Drizzle:
  - **Scope discovered**: 128 `db.prepare(...)` call sites across 13 files (routes/workspaces, routes/environments, routes/tasks, routes/agents, routes/inbox, routes/repositories, routes/github, services/environment, services/agent, services/taskQueue, services/github, services/prMonitor, services/backlog/service, services/continuousBuild, plus src/index.ts). Plus ~20 raw-SQL call sites across the test suite (`packages/backend/src/__tests__/`) that seed fixtures.
  - **Attempted this session**: rewrote `db/index.ts` to Drizzle + converted `routes/workspaces.ts` + `routes/environments.ts` as a proof-of-concept pattern.
  - **Why reverted**: mid-rewrite, main won't typecheck — `DB` type and `db.prepare` calls are incompatible between SQLite (remaining 11 files) and Postgres (the 3 rewritten). No clean incremental path because data lives in one DB (flag-day cutover, not strangler-patternable).
  - **Path for next session**:
    1. Resume by re-doing the conversion for `routes/workspaces.ts`, `routes/environments.ts`, and `db/index.ts`. The pattern is: import `Database` from `db/client.ts`; swap `db.prepare('SELECT ...').all()` for `db.select().from(table).where(...)`; swap `db.prepare('INSERT ...').run(...)` for `db.insert(table).values({...}).returning()`; `rowToXxx` helpers shrink since postgres-js auto-parses jsonb and returns Date objects.
    2. Then bulk-convert in this order: `routes/repositories` → `routes/integrations` (if exists) → `routes/tasks` (biggest, ~550 lines) → `routes/agents` → `routes/inbox` → `routes/github` → `routes/backlog` (mostly already delegates to services, small changes).
    3. Then services in dep order: `services/backlog/service` → `services/continuousBuild` → `services/github` → `services/prMonitor` → `services/agent` → `services/environment` (minimal DB) → `services/taskQueue` (biggest).
    4. Update `src/index.ts` — `initDatabase()` now returns the Drizzle client; `connectSavedEnvironments` needs the new query shape.
    5. Rewrite test suite: `__tests__/helpers/fakeEnvironment.ts` + every `describe` block that seeds via `db.prepare(...)`. Use pglite (`@electric-sql/pglite` already installed) for in-process Postgres. Expected test helper: `await createTestDb()` returns a Drizzle client over pglite with the migration applied; tests inject via `setDbClient()`.
    6. Drop `better-sqlite3` + `@types/better-sqlite3` from backend `package.json` + remove SQLite code from `db/index.ts` (the `getMigrations()` + `runMigrations()` functions — their logic is now encoded in the Drizzle schema).
    7. Final checks: `npm run typecheck`, `npm run lint`, `npm test --workspaces --if-present`, run `npm run dev:backend` locally against Supabase to hit the health endpoint.
  - **Estimated effort**: 3-4 hours of focused editing + 1-2 hours for tests. Single session, single atomic commit (no partial commits — keeps main green until it's done).
  - **Don't forget**: `jsonb` columns come back as parsed objects (not JSON strings) → remove `JSON.parse(row.field)`. Booleans come back as `true`/`false` (not `1`/`0`) → remove `=== 1` checks. Dates come back as `Date` instances (not ISO strings) → call `.toISOString()` when serializing to API responses.

- **Docs** landed/updated this session:
  - `docs/CONTINUOUS_BUILD_ROADMAP.md` already has Phase 18.1 + 18.4 (hosted backend) as #1 active — no doc change needed, just execution.
  - This session note.

- **Next action**: start fresh session. Re-read this note. Go through Phase C step-by-step per the plan above.

## Session 11 (Option 3 + fixes + hosting roadmap)
Shipped the "deterministic completion" path for Continuous Build tasks plus four targeted fixes, wrote the production roadmap, and stood up a one-command VM bootstrap script.

- **Option 3 (non-interactive autonomous mode)** (`packages/backend/src/services/agent.ts`):
  - New private `isAutonomousTask(taskId)` — looks up the task row, parses `metadata.backlogItemId`. True when the task was spawned by Continuous Build.
  - `startAgent` branches on this: autonomous tasks spawn `claude --print --permission-mode acceptEdits <quoted-prompt>` via the existing `bash -c` path in `environment.ts` (which already detected `claude --print` and runs accordingly). Process exit now = task done; `handleSessionClose(code=0)` transitions to `awaiting_review`; `code !== 0` transitions to `failed`. No prompt trickery, no hook, no polling.
  - Interactive (user-launched / pr_response / pr_review / manual) tasks unchanged — still PTY-based with prompt written via `writeToSession` after 500ms.
  - Prompt in `continuousBuild.ts:buildPrompt` rewritten: tells Claude to stop responding when done (exit is the signal); removed the "hit Ready for Review" instruction that was meant for humans.

- **Fix: SSH pty exit code** (`packages/backend/src/services/ssh.ts:189`, `agent.ts:178`):
  - ssh2's `stream.on('close', (code, signal) => ...)` does surface an exit code; we were ignoring it and always emitting 0. Now `pty:close` carries the real exit code (or 0 if ssh2 reports null for a normal close). Agent listener forwards it to `handleSessionClose`.

- **Fix: scheduler env-connectivity gate** (`continuousBuild.ts`):
  - New `isSourceEnvironmentReady(source)` — for SSH envs, skips sources whose env isn't `connected`. For local, always ready. Scheduler iterates sources, skips unconnected, tries next. Test covers the disconnect → connect → fire sequence.

- **`scripts/bootstrap-vm.sh`** (new):
  - Idempotent shell script, runnable over SSH (`ssh <host> bash -s -- [opts] < scripts/bootstrap-vm.sh`). Installs Node via nvm if < 18, npm-installs `@anthropic-ai/claude-code`, clones the FastOwl repo, builds shared + cli + mcp-server, npm-links the `fastowl` binary, writes `FASTOWL_API_URL` into `~/.bashrc` (in a managed block that round-trips safely on re-run). Flags: `--api-url`, `--branch`, `--install-dir`, `--skip-node`, `--skip-claude`, `--dry-run`, `--help`. This is the design target for the automated "Add SSH env → install daemon" flow that lands with Phase 18.3; until then you run it manually.

- **Docs**:
  - `docs/CONTINUOUS_BUILD_ROADMAP.md` — the top-of-queue plan. Three ordered phases: hosted backend (18.1+18.4), daemon split + SSH auto-install (18.3), Agent SDK migration (optional, later). Definition of done for "production ready" is explicit.
  - `docs/SSH_VM_SETUP.md` — fast path now front-loaded at the top pointing at the bootstrap script. Manual option kept below as fallback.

- **Tests**: 64 backend → 66 backend (2 new scheduler tests: env-disconnected skip, metadata.backlogItemId written on spawn). 66 + 7 MCP + 3 CLI + 1 desktop = 77 total.

- **Project doc updates**:
  - Priority queue re-ordered: hosted backend now #1 (active), daemon/auto-install #2, notifications #3. Continuous Build bulk-work moved to "done above." Everything else pushed to "later."
  - This session note.

Deferred: Layer-5 idle-timeout safeguard (nice-to-have — Option 3 means most timeouts are moot for autonomous tasks, only matters for interactive). Agent SDK migration (Phase 18 follow-up).

## Session 10 (Continuous Build — Phase 20)
Shipped the whole "point FastOwl at a TODO doc and it builds it" feature end-to-end, covering 20.1–20.5.

- **Backlog model** (`packages/backend/src/services/backlog/`):
  - `parser.ts` — GitHub-flavored markdown checklist parser with section scoping (`#/##/###`), indentation-based nesting, `(blocked)` / `[blocked]` detection, stable SHA1-based external IDs.
  - `service.ts` — DB helpers + `syncSource(id)` which reads the file via `environmentService.exec` and upserts items in a transaction, retiring vanished items rather than deleting (preserves claimed-task linkage).
  - Migrations 006 (`backlog_sources` + `backlog_items`) and 007 (`repository_id` on sources).
  - REST at `/api/v1/backlog/*` (sources CRUD + sync, items list, schedule trigger).

- **Scheduler** (`packages/backend/src/services/continuousBuild.ts`):
  - New in-process domain bus at `packages/backend/src/services/events.ts`. `emitTaskStatus` now fires on both websocket AND domainEvents.
  - Subscribes to `task:status`: on `completed` marks the claimed backlog item complete; on `failed/cancelled` releases the claim; on `awaiting_review` or any terminal status, re-evaluates `scheduleNext`.
  - `scheduleNext` respects workspace `continuousBuild.enabled/maxConcurrent/requireApproval`. Transactionally inserts a `code_writing` task row (status `queued`), claims the item, emits `task:status`.
  - Periodic 60s tick as safety net for missed events.

- **UI** (`apps/desktop/src/renderer/components/panels/SettingsPanel.tsx`):
  - New "Continuous Build" nav section. Toggle + `maxConcurrent` select + require-approval switch.
  - Source manager: add markdown_file source (path + section + environment), sync button per source, delete button.
  - Items preview with status chips.
  - "Run scheduler" button kicks `POST /backlog/schedule` for the current workspace.

- **`@fastowl/cli`** (new workspace `packages/cli`):
  - `fastowl task create|list|ready` + `fastowl backlog sources|sync|items|schedule` + `fastowl ping`.
  - Thin fetch client (`src/client.ts`) using native fetch, unwraps `ApiResponse<T>`, throws typed `ApiError` on failure.
  - Commander-based command setup. Env-aware defaults read `FASTOWL_API_URL`, `FASTOWL_WORKSPACE_ID`, `FASTOWL_TASK_ID`.
  - README at `packages/cli/README.md`, 3 client tests, wired into root `typecheck`.

- **Agent env injection**:
  - `agent.ts` now builds an inline `KEY=val KEY=val claude` prefix via new exported `buildFastOwlEnvPrefix(workspaceId, taskId, { includeApiUrl })`.
  - For **local** envs, `FASTOWL_API_URL=http://localhost:${PORT}` is included. For **SSH** envs it's omitted — the remote shell supplies it via `.bashrc` (see SSH setup doc).
  - Workspace/task IDs are always included so `fastowl task create` works without flags in the child session.

- **Docs**:
  - `docs/SSH_VM_SETUP.md` — full end-to-end: install Claude CLI + fastowl on the VM, three networking options (SSH reverse tunnel / LAN bind / backend on VM), wire up the SSH env in the desktop app, first task, turn on Continuous Build. Troubleshooting section covers the common cases (`claude: command not found`, `ECONNREFUSED` on child CLI calls, SSH drop).
  - `docs/CONTINUOUS_BUILD.md` — feature-level walkthrough: mental model, backlog file format, task-spawns-task via CLI, "turn it on for FastOwl itself" recipe, known limitations.

- **Tests**: 59 backend → 64 backend + 3 CLI = 67 total Vitest + 1 Jest smoke.
  - Parser: 9 tests (flat, nesting, section scoping, stop-at-heading, blocked detection, stable IDs, blank-skip, case-insensitive heading).
  - Service: 9 tests (round-trip, update, delete, syncSource add/retire/claim-preserved, nextActionableItem, skip-claimed, null-when-empty).
  - Scheduler: 8 tests (disabled no-op, spawn-on-empty, maxConcurrent cap, approval hold, approval-off proceed, task-completed → item-completed, task-failed → item-released, disabled-source skip).
  - Env prefix: 5 tests (API-URL default/override, task id optional, single-quote escape, SSH exclusion).
  - CLI: 3 tests (unwrap success, throw on error, POST body).
  - Extended `fakeEnvironment` helper to stub `exec` in addition to `spawnInteractive` so the backlog service's file-read path is testable without a real shell.

Deferred for 20.6: FastOwl MCP server. Deferred for 20.7: GitHub/Linear sources, priority inference, cross-source scheduling, structured `depends-on` annotations.

## Session 9 (Approval Gates — Phase 16.2 + 16.5)
- **Backend agent close** (`packages/backend/src/services/agent.ts`):
  - Clean exit (code 0) now sets task to `awaiting_review` instead of `completed` (no `completed_at`)
  - Non-zero exit still sets task to `failed`
  - Emits `task:status` WS event for the transition
- **New routes** (`packages/backend/src/routes/tasks.ts`):
  - `POST /tasks/:id/ready-for-review` — stops agent, moves task to awaiting_review (agent tasks only)
  - `POST /tasks/:id/approve` — awaiting_review → completed
  - `POST /tasks/:id/reject` — awaiting_review → queued for another pass
- **Frontend API + hooks** (`apps/desktop/src/renderer/lib/api.ts`, `apps/desktop/src/renderer/hooks/useApi.ts`):
  - `api.tasks.readyForReview/approve/reject` client methods
  - `readyForReview/approveTask/rejectTask` in `useTaskActions`
- **UI**:
  - `TaskTerminal` now has a primary "Ready for Review" button alongside "Stop" (stop = discard; ready = approval flow)
  - `QueuePanel` TaskDetail shows "Approve" and "Reject & Requeue" buttons when `task.status === 'awaiting_review'`

**Deferred**: git diff preview in the approval view, approval comments, push-after-approve automation, automated PR response triggering (16.3), PR review batch-post flow (16.4).

## Session 8 (Task Type System — Phase 16.1)
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

## Session 7 (Task Terminal History Persistence)
- **Migration 004** (`packages/backend/src/db/index.ts`):
  - Added `terminal_output TEXT NOT NULL DEFAULT ''` column to `tasks` table
- **Append-only task output** (`packages/backend/src/services/agent.ts`):
  - `handleSessionData` now appends incoming chunks to `tasks.terminal_output` via `SET terminal_output = terminal_output || ?`
  - Write cost proportional to each chunk rather than the full buffer
  - Agent record is still truncated to last 10k chars; task output grows for full history
  - Session close preserves the task's output (only deletes the stale agents row)
- **Tasks route** (`packages/backend/src/routes/tasks.ts`):
  - `rowToTask` now takes optional `{ includeTerminalOutput }` flag — only the single-task GET pulls the full output to keep list responses small
  - `/tasks/:id/terminal` falls back to `tasks.terminal_output` when no active agent, so completed/failed/cancelled tasks still return history
- **TerminalHistory component** (`apps/desktop/src/renderer/components/panels/TerminalHistory.tsx`):
  - Fetches task terminal output on mount via `api.tasks.getTerminal`
  - Renders in read-only XTerm with collapse/expand toggle and char count
  - Wired into QueuePanel TaskDetail for `completed`, `failed`, `cancelled` statuses

**Deferred for Phase 15.2/15.4**: structured ndJson conversation log, session resume via Claude CLI, collapsible tool-use sections, history search.

## Session 6 (PR Monitoring + Repository Selector)
- Created PR Monitor service (`packages/backend/src/services/prMonitor.ts`):
  - Polls watched repos every 60 seconds for changes
  - Tracks PR state (reviews, comments, CI status, mergeability)
  - Creates inbox items for: new reviews (approved, changes requested), new review comments, new general comments, CI failures, PR becoming mergeable
  - Filters out user's own comments to avoid self-notifications
  - Initializes state on first poll without creating notifications
- Extended GitHub service (`packages/backend/src/services/github.ts`):
  - Added getPRReviews, getPRReviewComments, getPRComments methods
  - Added GitHubReview, GitHubReviewComment, GitHubIssueComment interfaces
  - Added getConnectedWorkspaces method
- Created repository routes (`packages/backend/src/routes/repositories.ts`):
  - GET / — list watched repos for workspace
  - POST / — add watched repo
  - DELETE /:id — remove watched repo
  - POST /poll — force poll refresh
- Added frontend API client for repositories (`apps/desktop/src/renderer/lib/api.ts`):
  - WatchedRepo type
  - list, add, remove, forcePoll methods
- Updated WorkspaceSettings in SettingsPanel:
  - Real watched repositories list from backend
  - Repository selector with GitHub repo search
  - Add/remove repository functionality
  - Manual poll refresh button

## Session 5 (GitHub OAuth Integration)
- Created GitHub service (`packages/backend/src/services/github.ts`):
  - OAuth authorization URL generation with CSRF state
  - Code-to-token exchange
  - Token storage in integrations table
  - REST API methods: getUser, listRepositories, listPullRequests, getPullRequest, getCheckRuns, createPRComment
  - Auto-load tokens on service init
- Created GitHub routes (`packages/backend/src/routes/github.ts`):
  - GET /status — check configuration and connection status
  - POST /connect — start OAuth flow, return auth URL
  - GET /callback — handle OAuth callback, store token
  - POST /disconnect — remove token
  - GET /user — get authenticated user
  - GET /repos — list repositories
  - GET /repos/:owner/:repo/pulls — list PRs
  - GET /repos/:owner/:repo/pulls/:number/checks — get CI status
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

## Session 4 (Task Queue UI + Settings Panel + ESLint + Workspace Editing)
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

## Session 3 (Terminal + Environment UI)
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

## Session 2 (Foundation + Backend Services)
- Restructured to monorepo: `apps/desktop`, `packages/backend`, `packages/shared`
- Created all core types in `@fastowl/shared`
- Built backend server with Express + WebSocket, SQLite database with migrations, REST API routes for all entities, WebSocket service for real-time events
- Added Tailwind CSS + PostCSS to renderer
- Created shadcn/ui style components (Button, Card, Badge, ScrollArea)
- Built UI shell with Sidebar (workspace selector, navigation, environment status), InboxPanel (prioritized items, actions, read/unread states), TerminalsPanel (agent list, terminal view, status indicators), QueuePanel (task list, detail view, priority badges)
- Added Zustand store for app state management
- **SSH Service** (`packages/backend/src/services/ssh.ts`): SSH connection management via ssh2, connection pooling and auto-reconnection, PTY support for interactive terminal sessions, command execution on remote environments
- **Environment Service** (`packages/backend/src/services/environment.ts`): Manages local + SSH environments, health checking, interactive session spawning
- **Agent Service** (`packages/backend/src/services/agent.ts`): Spawns Claude CLI processes on environments, output parsing for status detection, auto-creates inbox items when agent needs attention, agent lifecycle management
- **Task Queue Service** (`packages/backend/src/services/taskQueue.ts`): Automatic task assignment to idle agents, priority-based queue processing, respects workspace maxConcurrentAgents setting
- **Frontend API Client** (`apps/desktop/src/renderer/lib/api.ts`): HTTP client for all backend endpoints, WebSocket client with auto-reconnection, real-time event handling
- **React Hooks** (`apps/desktop/src/renderer/hooks/useApi.ts`): `useApiConnection`, `useInitialDataLoad`, `useAgentActions`, `useTaskActions`, `useInboxActions`
- App auto-detects backend availability; falls back to demo data if not running

## Session 1 (Initial)
- Created the initial context document
- Explored Electron boilerplate structure
- Reviewed PostHog's Coder devbox implementation for reference
- Established architecture decisions
- Created initial TODO list
