# @talyn/admin — the operator console (admin.talyn.dev)

Fleet operations, cross-tenant product admin, and the Debug surface, in one
place. Forked from `apps/web`, so **read [`../web/README.md`](../web/README.md)
first** — every constraint it documents (Vite env, the OAuth redirect shape,
`vercel.json` placement, the `dist`-resolution build order) applies here
unchanged. This file covers only what is different.

## What this app is

Everything it shows is **cross-tenant**: other people's users, workspaces,
tasks and agent transcripts, plus the fleet hosts that run them. It can also
change things — drain a host, cancel a run, comp an account, grant admin — and
every one of those writes a row to `admin_audit_log`.

That framing drives most of the decisions below. When in doubt, ask "would I be
comfortable with this ending up in a third-party tool, or in a screenshot?"

## Running it

```bash
npm run dev:admin        # port 5174
```

`5174`, not `5173` — `apps/web` sets `strictPort: true` on 5173, and running
both at once is the normal case.

Tests:

```bash
npx vitest run --root apps/admin      # or: npm test -w @talyn/admin
```

**Pass `--root apps/admin`** (or use the workspace script). Running `npx vitest`
from the repo root picks up neither this app's `vitest.config.ts` — so
`environment: 'jsdom'` never applies and every DOM test fails with `document is
not defined` — nor its `include` glob, so it also tries to run the backend's
pglite suites and hangs.

You need `is_admin` on your user. Set `TALYN_ADMIN_EMAILS=<your login email>`
in the backend `.env` and sign in again; the JWT middleware promotes on token
verify (promote-only — it never demotes). Without it you get the
"Operators only" screen, which is the correct behaviour, not a bug.

## Differences from apps/web

### Analytics posture — the one to not "sync back"

| Setting | apps/web | here | why |
|---|---|---|---|
| `disable_session_recording` | `false` | **`true`** | A replay of this console is a more complete copy of the production database than anything else we hold, in a tool with a different access model. |
| `autocapture` | `true` | **`false`** | Autocaptured element text on a cross-tenant table is customer data. |
| `capture_pageview` | `false` | **`true`** | This is a real multi-page router; the product apps are single-surface and track panels as events. |
| `client` super property | `web` | `admin` | Three front ends now report into one PostHog project. Without it every funnel silently merges them. |

`src/__tests__/analyticsPosture.test.ts` asserts all of these, precisely
because they are single-flag differences that a future "sync the fork" pass
would revert without anyone noticing.

Mutation analytics never carries the reason text — it can contain customer
identifiers, and **PostHog is not the audit log**; the backend is.

### Routing — plain react-router, no zustand panel store

The product apps keep `activePanel` in a zustand store and mirror it into the
URL with `usePanelUrlSync`. That hook exists because `apps/web` is a fork of
the desktop renderer, which has no URL bar. None of its premises hold here:
no desktop twin, no onboarding wizard, no debug-mode bounce, and — the
load-bearing one — **no workspace selection**, because this console is
cross-tenant by definition. A global store with no job is a race waiting to
happen.

`src/lib/routes.ts` is the single source of truth for URLs; `App.tsx` builds
its `<Route path=…>` from it and `src/lib/nav.ts` links to it, typed as
`RoutePath`. What that gives up versus the product apps' `satisfies
Record<ActivePanel, string>` is the guarantee that a nav entry's route is
actually **mounted** — `src/__tests__/sidebarNav.test.tsx` is the runtime
replacement, and it asserts against the page `<h1>` inside `<main>` rather than
the whole body (the sidebar contains every nav label, so a body-text assertion
passes for a page that never rendered).

Drill-ins are **routes, not modals**. An operator's commonest act is pasting a
run id into Slack.

### Dependencies dropped

`@pierre/diffs`, `jdenticon`, `react-markdown`, `rehype-*`, `remark-gfm`. The
fleet transcript is JSON, not markdown, and an app holding cross-tenant data
should not re-introduce an HTML-rendering path it does not need — `apps/web`'s
README names its sanitised markdown pipeline as one of two mitigations for the
localStorage-session XSS risk. Render text in
`<pre className="whitespace-pre-wrap">`.

### The gate is cosmetic

`AdminGate` exists so that **nothing mounts** behind it — no page component, no
query, no WebSocket. The security boundary is the server: `requireAdmin` on
every `/api/v1/admin` route except `/admin/me`, plus separate `isAdmin` checks
on the WS fan-out and the `debug:filter` handler. A non-admin who flips the
gate in devtools sees a shell where every request 403s. That is the design.

Its three-way outcome is load-bearing and easy to collapse by accident:

- `{admin:false}` → "Operators only"
- the request **failed** → "Couldn't verify your access" + retry
- still asking → the boot spinner

A transport failure is **not an answer**. Telling an operator they are not an
operator because the backend was restarting is both wrong and alarming, and it
is the exact bug `apps/web`'s `offlineBanner.test.tsx` was written to prevent
elsewhere.

### EnvironmentBadge

Renders the backend host, amber whenever it is not `prod.talyn.dev`. Not
decoration: the URL bar says `admin.talyn.dev` whether the API underneath is
production or a laptop, and this app drains hosts.

## Deploying

Vercel project **Root Directory must be `apps/admin`**, and `vercel.json`
**stays in this directory** — all three deploys invoke the Vercel CLI from the
repo root, so a root-level config would be picked up by the others (this was
tried once and broke the marketing deploy).

`.github/workflows/deploy-admin.yml` needs `VERCEL_PROJECT_ID_ADMIN`. Mind the
naming — two of the three folder names disagree with their project names:

| Secret | Project | Domain | Source dir |
|---|---|---|---|
| `VERCEL_PROJECT_ID_WEB` | web = the marketing **website** | www.talyn.dev | `apps/marketing` |
| `VERCEL_PROJECT_ID_APP` | app = the **application** | app.talyn.dev | `apps/web` |
| `VERCEL_PROJECT_ID_ADMIN` | admin | admin.talyn.dev | `apps/admin` |

The secret, not the folder, decides where a build lands.

### One-time setup outside this repo

1. **Backend `ALLOWED_ORIGINS`** (Railway) must include
   `https://admin.talyn.dev`. Exact string match, no globs — see
   `services/originPolicy.ts` for why. It covers both CORS and the WebSocket
   upgrade, and it is **read once at boot**, so it needs a restart. Without it
   the console's first request fails as a CORS error with *no server-side log*.
2. **Supabase dashboard** → Authentication → URL Configuration → Redirect URLs
   → add `https://admin.talyn.dev/auth/callback`. Client-side OAuth means
   Supabase owns this allowlist, not our backend. (Local dev is already in
   `supabase/config.toml`.)
3. **Vercel project env**: `VITE_TALYN_API_URL=https://prod.talyn.dev`,
   `VITE_TALYN_SUPABASE_URL`, `VITE_TALYN_SUPABASE_ANON_KEY`, optionally the
   PostHog pair. `vite.config.ts` fails the build on a missing one and refuses
   any value containing `service_role`.
4. Leave `TALYN_ADMIN_GRANT_ENABLED` **unset**. Granting admin is the one
   mutation that permanently widens the blast radius of every other one, so it
   is off unless a deploy explicitly opts in.

`WEB_APP_URL` needs no change — it is the GitHub App callback target, and this
console has no GitHub-connect flow.
