# FastOwl Testing Plan

FastOwl is changing quickly across three packages (Electron desktop, Node backend, shared types) and several runtime surfaces (SSH, PTY, Claude CLI, GitHub API, SQLite). This document is the single source of truth for *how we test*, *what we test*, and *when it runs*. It's meant to be followed incrementally — we don't need 100% coverage on day one, we need a foundation we can grow.

## Principles

1. **Every change that ships gets type-checked in CI.** Already in place (`npm run typecheck`). Non-negotiable.
2. **Favour integration-style tests over unit tests.** FastOwl is mostly orchestration (routes → services → DB, environments → PTY, WebSocket events). Pure unit tests rarely catch the failures that actually bite us; integration tests do.
3. **No mocking the DB.** Use a real in-memory SQLite (`better-sqlite3` with `:memory:`). The DB is fast, deterministic, and one of the most bug-prone surfaces — mocking it defeats the purpose.
4. **Mock only I/O we can't control locally.** `claude` CLI, SSH, GitHub API, WebSocket clients. Wrap these in thin service interfaces so tests can inject stubs.
5. **CI runs fast enough to be part of the inner loop.** Target: < 2 minutes total on ubuntu for typecheck + lint + unit + integration. E2E tests can be slower but are gated to main.

## Stack

| Layer                          | Tool                                 | Why                                               |
| ------------------------------ | ------------------------------------ | ------------------------------------------------- |
| Backend unit + integration     | **Vitest** (or keep Jest)            | Fast, native TS, easy SQLite + fake-timer support |
| Frontend unit (React hooks)    | **Vitest + @testing-library/react**  | Same runner = one mental model                    |
| Electron E2E                   | **Playwright** with Electron driver  | First-class Electron support, GitHub Actions runs |
| API contract (WS + HTTP)       | **supertest** for HTTP, raw `ws` client for WebSocket | No extra framework needed               |
| Snapshot / diff regression     | Vitest inline snapshots              | For git diff rendering, output parsing patterns   |

> Current desktop package already uses Jest + ts-jest. **Decision point**: either migrate desktop to Vitest for consistency (preferred) or keep Jest and add Vitest to backend. Recommendation: migrate once, then single stack. The cost is a one-time rewrite of `apps/desktop/src/__tests__/App.test.tsx` plus a new config file — low because there's only one existing test.

## Test layers

### Layer 1: Typecheck + lint (already green)

- `npm run typecheck` — all three packages.
- `npm run lint` — zero errors, warnings tolerated.
- Runs on every push and PR via `.github/workflows/test.yml`.

### Layer 2: Backend unit + integration (priority)

Target the services and routes that hold the most state. Examples of first-wave tests (in `packages/backend/src/__tests__/`):

- `db.migrations.test.ts` — run migrations against `:memory:` DB, assert schema matches expectation, assert migration 005 renames `automated` → `code_writing`.
- `taskQueue.test.ts` — queue → assign → process flow with a fake agent service; covers `recoverStuckTasks`, `processQueue`, priority ordering.
- `gitService.test.ts` — driven through a fake environment that captures command strings; assert the right git commands are emitted for `createTaskBranch`, `getDiff`, `stashChanges`.
- `agent.statusDetection.test.ts` — feed sample Claude CLI output, assert `STATUS_PATTERNS` detect the right states. Regression protection when output format drifts.
- `routes/tasks.test.ts` — supertest against the Express app with an in-memory DB + mocked agent/git services. Covers: create / list / start / ready-for-review / approve / reject / retry / stop / diff.
- `routes/repositories.test.ts` — add/remove watched repos with GitHub mocked.
- `prMonitor.test.ts` — state transitions: new review → inbox item; second poll with same review doesn't double-fire.

**Fake environment**: a test double implementing the `environmentService` interface that records command strings and returns fixture outputs. This is the single largest investment — once it exists, most service tests fall out of it cheaply.

### Layer 3: Frontend unit + hook tests

Keep this layer small. React components in FastOwl are mostly presentational — they read from Zustand store + call typed API functions. Test where logic lives:

- `useApi.test.ts` — hooks like `useTaskActions` wrap the `api` client. Test that `readyForReview` calls the right endpoint + updates the store.
- `TerminalHistory.test.tsx` — fetches on mount, handles loading / error / empty / populated states.
- `TaskDiff.test.tsx` — given a fixture diff, renders colored lines + correct `+N -M` stats.
- Zustand store selectors + actions.

Don't test `XTerm.tsx` (too much glue with the DOM), `App.tsx` (it's a router shell), or 1:1 component snapshots.

### Layer 4: E2E (Playwright + Electron)

Gate to `main` + pre-release. ~5 golden-path flows:

1. **Cold start → create task → see it queued.** Launches Electron, opens the app, creates a `code_writing` task, asserts it lands in the queue list.
2. **Approve an awaiting-review task.** Seeds a DB row via an exposed test-only HTTP endpoint (or direct DB write in a test mode), loads the task, clicks Approve, asserts it moves to completed.
3. **Reject → requeue.** Same but click Reject.
4. **GitHub disconnect flow.** Settings panel → Disconnect → integrations table updated.
5. **WebSocket reconnect.** Kill backend mid-session, restart, assert the UI recovers (this catches a class of bug that silent reconnect logic hides).

## CI wiring

Update `.github/workflows/test.yml`:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - checkout, setup-node@v4, npm install
      - npm run typecheck
      - npm run lint
      - npm run test         # layer 2 + 3

  build-matrix:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix: { os: [macos-latest, windows-latest, ubuntu-latest] }
    steps:
      - checkout, setup-node@v4, npm install
      - npm run build        # catches platform-specific build issues

  e2e:
    runs-on: ubuntu-latest
    needs: [check]
    if: github.ref == 'refs/heads/main' || contains(github.event.pull_request.labels.*.name, 'run-e2e')
    steps:
      - checkout, setup-node@v4, npm install
      - npx playwright install --with-deps chromium
      - npm run test:e2e
```

Key moves:
- Fast check lane (single OS) runs on every push for quick feedback.
- Heavier build matrix validates cross-platform compile, but skips lint/test duplication.
- E2E runs on main merges + opt-in PRs (via label) to keep PR CI fast.

## Keeping tests healthy

- **Every PR that changes `packages/backend/src/services/*` adds or updates a test.** Enforced by review, not CI.
- **Every new route adds a supertest case.** Same.
- **Every new migration adds a migration test.** Catch schema drift.
- **Tests live next to the code in `__tests__/` folders**, mirroring the source tree.
- **Fixtures in `__tests__/fixtures/`.** GitHub API responses, Claude CLI transcripts, sample diffs.
- **On a test failure, do not disable. Diagnose or delete with reason.** A silenced test is dead weight.

## Rollout plan

1. **Week 1** — Decide Vitest vs Jest. Stand up Vitest on backend, port the one desktop test, add CI step (`npm run test`). Land the fake environment harness.
2. **Week 2** — Cover `taskQueue`, `agent` status detection, `gitService`, migration 001→current. Target: ~40% backend service coverage.
3. **Week 3** — Cover routes (`/tasks/*`, `/repositories/*`, approval endpoints). Supertest + in-memory DB.
4. **Week 4** — Frontend hook tests (`useTaskActions`) and small components (`TerminalHistory`, `TaskDiff`).
5. **Week 5+** — Playwright E2E flows. First flow on main. Iterate from there.

After week 5, testing should be routine: every feature lands with tests, CI enforces it, and regressions are caught before approve/push.

## Open decisions

- **Vitest vs Jest**: default to Vitest unless there's a compelling reason not to. ESM + TS story is simpler.
- **Electron driver**: Playwright's built-in Electron support or `electron-playwright-helpers`. Try vanilla first.
- **Test data seeding for E2E**: direct SQLite write vs a hidden HTTP endpoint. Direct write is simpler, avoids security concerns about a test-only endpoint leaking to prod.
- **Flake budget**: tolerate 0 flakes in layers 1-3. Allow up to 1 retry in layer 4 (E2E), tracked in a weekly report.
