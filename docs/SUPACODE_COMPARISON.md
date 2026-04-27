# Supacode vs FastOwl — internals comparison

Notes from a code-level comparison of [supabitapp/supacode](https://github.com/supabitapp/supacode) (a native macOS Swift "AI coding mission control" app) against FastOwl. Captured 2026-04-27.

Supacode is local-first / single-machine. FastOwl is client-server with a hosted backend on Railway. Most architectural deltas trace back to that one difference.

## At a glance

| Aspect | Supacode | FastOwl |
| --- | --- | --- |
| Runtime | Native macOS Swift (Tuist + TCA) | Electron (TypeScript, React, Vite) |
| Terminal | [Ghostty](https://ghostty.org/) (real PTY) | XTerm.js in renderer |
| Persistence | `~/.supacode/{sidebar,settings,layouts}.json` (atomic, TCA `@Shared`) | Postgres on Supabase, RLS, owner_id scoping |
| Auth | None — single-user-on-this-Mac | Supabase GitHub OAuth + JWT |
| Multi-machine | No | Yes (daemon-everywhere) |
| Working tree per task | Git worktree (one directory per task) | Single working directory + branch checkout |
| GitHub | Shells out to `gh` CLI | Direct REST + GraphQL via OAuth tokens |
| PR open | Manual / `gh pr create` | LLM-generated title + body, opened automatically |
| CI poll | 30s focused / 60s unfocused | Fixed 60s (`prMonitor`) |
| CLI ↔ app | Unix domain socket at `/tmp/supacode-<uid>/pid-<pid>` | HTTP + bearer JWT |

## Git operations

**Supacode** — shells to `git`, no libgit2. Ships a custom `Resources/git-wt/wt` script that wraps `git worktree` with `copy-ignored` and `copy-untracked` semantics so `.env` files / `node_modules` symlinks transfer into a fresh worktree without rebuilding from scratch (`GitClient.swift:255–336`, streams `GitWorktreeCreateEvent` lines as it works). No per-task audit log.

**FastOwl** — also shells out, every command goes through `runGit` → `void recordGitCommand` → `metadata.gitLog` for the desktop Git tab. Per-task audit is a real differentiator.

## Worktrees — biggest divergence

**Supacode**: one git worktree per task on disk, isolated. Worktree ID = absolute path (`GitClient.swift:78–120`, `WorktreeCommand.swift`). Two agents on the same repo never collide because they live in different directories. Teardown is `git worktree remove` + branch delete.

**FastOwl**: one working directory per repo; agents take turns via the `(env, repo)` slot guard (`findTaskHoldingEnvRepoSlot`) + branch checkout. The slot guard exists *because* of this design.

This is the single biggest architectural delta. With worktrees, the slot guard goes away, two tasks on the same repo can run concurrently, and the `dirty-after-commit` failure mode (which we fixed in Session 22) becomes unreachable — each task has its own working tree to dirty.

## Agent execution / environments

**Supacode**: terminal panes are powered by Ghostty, a real C-library terminal emulator. Processes spawn via Swift `Process` with stdout/stderr piped into line streams. **No daemon split** — everything runs in the macOS app on the same Mac. No remote-VM concept exists.

**FastOwl**: daemon-everywhere split with WebSocket dial-back, exists precisely so agents can run on a remote VM. Different problem space.

## State persistence

**Supacode**: no SQL.

- `~/.supacode/sidebar.json` — repos, worktrees, collapse/pin/archive state, selection
- `~/.supacode/settings.json` — global + per-repo config (scripts, run settings, open actions, keybinds)
- `~/.supacode/layouts.json` — terminal window/tab/pane layouts

Written atomically via TCA's `@Shared`. **Corrupt files are renamed `.corrupt-<ISO8601>` rather than dropped** (`SidebarPersistenceKey.swift:90–114`) — preserves user data on parse failures. Worktree metadata is read live from `.git/worktrees/` on every list — single source of truth is the filesystem.

**FastOwl**: Supabase Postgres + RLS, owner_id scoping, server-side scheduling. Necessary for multi-machine / multi-user.

## GitHub auth

**Supacode** shells everything to the user's `gh` CLI. No OAuth flow, no token storage, no client_id/secret. `gh auth status --json` is the only auth surface (`GithubCLIClient.swift:456–471`). 30s TTL cache on `GithubIntegrationClient` to avoid re-shelling.

**FastOwl** does the full OAuth dance, stores tokens in `integrations`, reimplements REST + GraphQL. More flexible (works without `gh` installed), more surface area.

## PR lifecycle

**Supacode** only *reads* PRs — never opens them. Users push and run `gh pr create` themselves. Action commands (`gh pr merge | close | ready` at `GithubCLIClient.swift:322–374`) exist but are explicit user actions. No LLM-generated title/body.

**FastOwl** opens PRs end-to-end with LLM-written title + body, fills repo PR templates if present. Real product differentiator.

### Tiered PR matching (smart pattern)

When multiple PRs target the same branch (upstream, fork, deleted fork), `GithubGraphQLPullRequestResponse.pullRequestsByBranch()` ranks candidates: upstream > fork > deleted-fork. Handles fork workflows where the original PR's fork was deleted; FastOwl would just lose the pointer.

## CI / checks tracking

**Supacode** is genuinely smart here. They batch PR + checks + reviews in **one GraphQL query**:

- `batchPullRequests()` chunks branches into groups of 25 and fires up to 3 concurrent queries (`GithubCLIClient.swift:295–320`).
- Each query aliases per-branch fetches and pulls `statusCheckRollup.contexts(first: 100)` as a `CheckRun | StatusContext` union.
- `GithubPullRequestStatusCheck.swift:47–78` collapses GitHub's three-axis (`status` / `conclusion` / `state`) into one verdict per check.
- `PullRequestMergeReadiness.swift:10–39` rolls up `mergeable` + `mergeStateStatus` + `reviewDecision` + failed-checks-count into a `blockingReason` enum: `mergeConflicts | changesRequested | checksFailed(Int) | blocked`.

Single batched GraphQL call → single computed verdict per PR.

**FastOwl**'s `prMonitor` polls per-PR with separate REST calls for reviews / comments / checks and computes inbox items individually. More chatty, more code.

## Polling cadence

**Supacode**: adaptive — 30s for the focused worktree, 60s for everything else (`WorktreeInfoWatcherManager.swift:130–161`). Plus a `DispatchSourceFileSystemObject` watcher on `.git/HEAD` for instant local branch-change events (no polling needed). 5s cooldown after a manual PR selection prevents re-fetch spam.

**FastOwl**: fixed 60s in `prMonitor`.

## CLI ↔ app IPC

**Supacode**: Unix domain socket at `/tmp/supacode-<uid>/pid-<pid>` (`AgentHookSocketServer.swift:33–34`).

- CLI discovers live sockets by scanning `/tmp/supacode-<uid>/`, checking `kill(pid, 0)` for liveness, launching the app via `open -a` if none.
- Trust = filesystem UID. No tokens.
- Wire format = newline-delimited JSON. Four message types: busy-flag, notification, command (deeplink), query.

**FastOwl**: HTTP + bearer JWT, hosted backend, works across machines.

## Notification surfaces

**Supacode**: `NotificationSoundClient` plays sounds on agent events; dock badge updates on `notificationIndicatorChanged`. No "review-comment-landed" awareness — they fetch full PR state including `reviewDecision` on each poll but don't diff or alert on review events.

**FastOwl**: prioritized inbox + WS-driven banners + OS notifications on `awaiting_review` (Session 17).

## What's worth borrowing into FastOwl

Most leveraged first:

1. **Git worktree per task.** Removes the slot-guard machinery, lets two tasks on the same repo run concurrently, makes the `dirty-after-commit` failure mode unreachable. Migration path: `prepareTaskBranch` becomes `prepareTaskWorktree` returning an absolute path; `assignedEnvironmentId` semantics stay; drop `findTaskHoldingEnvRepoSlot`. Roughly a one-week refactor.
2. **Batched GraphQL for PR + checks.** Replace `prMonitor`'s per-PR REST round-trips with one GraphQL call per repo, rolling up `statusCheckRollup`. Cheaper at scale and less code.
3. **Tiered PR matching.** Handle fork PRs and deleted-fork PRs without losing the pointer.
4. **Adaptive polling.** Focused vs unfocused intervals — cheaper at idle, snappier when the user is looking.
5. **`copy-ignored` / `copy-untracked` semantics** when worktrees land — `.env` and `node_modules` survive worktree creation without rebuild.
6. **Atomic JSON writes with `.corrupt-<ts>` rename on parse failure** — applies to anything we persist locally (settings, drafts, daemon config).

## What's NOT worth borrowing (given FastOwl's scope)

- **`gh`-shellout for GitHub.** Simpler but assumes `gh` is installed + authed. Hosted backend can't shell out to a user's machine, so OAuth + tokens stays.
- **JSON-file persistence.** Incompatible with multi-user / multi-machine.
- **Unix socket IPC.** Ditto — CLI needs to talk to a hosted backend.
- **Ghostty for terminals.** Electron/web stack means XTerm.js stays.

## Files cited

Supacode source paths (relative to repo root):

- `supacode/Clients/Git/GitClient.swift` — git ops, worktree creation streaming
- `Resources/git-wt/wt` — custom worktree wrapper (copy-ignored, copy-untracked)
- `supacode-cli/Commands/WorktreeCommand.swift` — CLI surface
- `supacode/Infrastructure/AgentHookSocketServer.swift` — Unix-socket IPC server
- `supacode-cli/Transport/{SocketDiscovery,SocketClient,Dispatcher}.swift` — CLI discovery + dispatch
- `supacode/Clients/Github/GithubCLIClient.swift` — `gh` shellout, batch GraphQL query
- `supacode/Clients/Github/GithubIntegrationClient.swift` — auth cache (30s TTL)
- `supacode/Clients/Github/GithubGraphQLPullRequestResponse.swift` — tiered PR matching
- `supacode/Clients/Github/PullRequestMergeReadiness.swift` — merge-block verdict
- `supacode/Clients/Github/GithubPullRequestStatusCheck.swift` — check-state normalization
- `supacode/Features/.../WorktreeInfoWatcherManager.swift` — adaptive PR/CI polling, HEAD file-watcher
- `supacode/Features/Repositories/BusinessLogic/SidebarPersistenceKey.swift` — atomic JSON state
