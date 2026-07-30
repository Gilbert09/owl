# @talyn/web

The browser app behind **app.talyn.dev**. Vite + React 19, an npm workspace
member (unlike `apps/marketing`, which is deliberately outside the workspace),
so it can depend on `@talyn/client` and `@talyn/shared`.

## Status

**Scaffold.** The frame is real — routing, browser PKCE auth, the shared
transport, the CSP, the deploy pipeline — but the panels themselves are still
being ported from `apps/desktop/src/renderer`. `routes/Shell.tsx` is the
placeholder they replace.

## Run it

```bash
cp .env.example .env      # fill in the anon key
npm run dev -w @talyn/web # http://localhost:5173
```

Needs `npm run dev:db`, `npm run dev:redis`, and `npm run dev:backend` at the
repo root. `@talyn/client` must be built first (`npm run build -w
@talyn/client`) — it resolves from `dist`, not source.

## Things that will bite you

**Env is `import.meta.env.VITE_*`, not `process.env.*`.** Vite's `define`
entries are "defined as globals during dev and statically replaced during
build", so copying the desktop's webpack `EnvironmentPlugin` pattern serves the
dev browser an unsubstituted `process.env.X` and throws on the missing
`process` global. `vite.config.ts` also *fails* a production build when a
required key is empty — a white screen on a public URL is far worse than the
desktop's runtime throw — and refuses any value containing `service_role`.

**This is a fork of the desktop renderer, on purpose.** Features get built
twice. What is *not* forked is the backend contract: both apps import
`@talyn/client`, so routes and WS events have one definition.

**Auth differs from the desktop in three specific ways** (see
`src/lib/supabase.ts` and `src/components/auth/AuthProvider.tsx`):
`detectSessionInUrl: true`; a full-page redirect rather than
`skipBrowserRedirect` + `openExternal` (which loses user activation and gets
popup-blocked in Safari); and **no** `migrateLegacyAuthFromLocalStorage` —
here the "bridge" *is* localStorage, so it would wipe the session every load.

**The session lives in localStorage**, which is a real security downgrade from
the desktop's OS-keychain-backed `safeStorage`: an XSS here exfiltrates a
refresh token. The mitigations are the strict CSP (`vercel.json` header, with
the `index.html` meta as the dev-server equivalent) and the sanitised markdown
pipeline. Keep `script-src 'self'` intact — it works only because
`posthog-js/dist/module.full.no-external` is bundled rather than CDN-loaded.

## Deploy

Its own Vercel project via `.github/workflows/deploy-app.yml`.

**Naming.** The two Vercel deploys are *web* — the marketing WEBSITE,
www.talyn.dev, `VERCEL_PROJECT_ID_WEB` — and *app*, the APPLICATION,
app.talyn.dev, `VERCEL_PROJECT_ID_APP`. This directory is `apps/web` but ships
to the **app** project, which reads backwards; the secret, not the folder, is
what decides where a build lands.

**The Vercel project's Root Directory must be the repo root**, not `apps/web`.
The build has to run npm workspace commands (`@talyn/shared` and
`@talyn/client` are compiled first), and those only work from the workspace
root. That's also why `vercel.json` lives at the repo root — Vercel reads it
from the project's Root Directory. Marketing is unaffected: its Root Directory
is `apps/marketing`, so it never sees that file.

Build-time `VITE_TALYN_*` values are Vercel project environment variables.
`vite.config.ts` fails the build if any required one is missing, so a
half-configured project fails loudly rather than shipping a white screen.
