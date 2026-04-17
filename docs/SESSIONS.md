# FastOwl Session Notes

Chronological notes from development sessions. Most recent first. See [`CLAUDE.md`](../CLAUDE.md) for the project context and [`ROADMAP.md`](./ROADMAP.md) for the phased TODO.

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
