# FastOwl Setup Checklist

Actions you (Tom) need to take outside this repo. Everything that *can* be automated by Claude Code is being automated — this doc covers the things that require your credentials, accounts, or browser approval.

Legend:
- ⚡ **Now** — needed for current dev loop
- 🔜 **Soon** — needed for Phase 18 (hosted backend)
- 🧰 **Nice-to-have** — dev ergonomics, do when convenient

---

## ⚡ Required now

### 1. Anthropic API key

Used by `packages/backend/src/services/ai.ts` for auto-generating task titles/descriptions from prompts.

1. Go to https://console.anthropic.com/settings/keys
2. Create a key
3. Export it when running the backend:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
   Or add it to a `.env` file at the repo root (add to `.gitignore` first — don't commit).

Without this, task metadata falls back to first-60-chars heuristic, which is functional but noticeably worse.

### 2. `claude` CLI on every environment

FastOwl spawns `claude` (interactive mode) via node-pty on the chosen environment. The binary must be in the PATH of whichever shell gets spawned.

- **Local**: `npm install -g @anthropic-ai/claude-cli` (or whatever the current install command is), log in via `claude login`
- **VMs**: same, on the remote user's shell

Verify by running `claude --version` as the shell user FastOwl will use.

### 3. GitHub OAuth app (already scaffolded in backend)

Used by Phase 6 integration (connect GitHub → PR monitoring, PR actions, repo listing).

1. https://github.com/settings/developers → **New OAuth App**
2. Application name: `FastOwl (Dev)` (make a separate prod one later)
3. Homepage URL: `http://localhost:4747`
4. Authorization callback URL: `http://localhost:4747/api/v1/github/callback`
5. Create, then **Generate a new client secret**
6. Export before running the backend:
   ```bash
   export GITHUB_CLIENT_ID=Iv1.xxxxx
   export GITHUB_CLIENT_SECRET=xxxxx
   export GITHUB_REDIRECT_URI=http://localhost:4747/api/v1/github/callback
   ```

Without these, the "Connect GitHub" button in Settings will fail loudly.

---

## 🔜 Needed for Phase 18 (hosted backend)

Do these when we're ready to stand up the hosted infrastructure — not urgent yet, but creating the accounts early is free and removes friction when we get there.

### 4. Supabase project

For Postgres + auth when Phase 18.1/18.2 lands.

1. Create account at https://supabase.com
2. New project (free tier is fine for dev) — pick closest region
3. From the project dashboard, grab:
   - `SUPABASE_URL` (Project settings → API → Project URL)
   - `SUPABASE_ANON_KEY` (same page → anon public)
   - `SUPABASE_SERVICE_ROLE_KEY` (same page → service_role) — **never expose to the desktop app**, backend only
   - `DATABASE_URL` (Project settings → Database → Connection string → URI, with pooling for runtime)
4. Enable GitHub OAuth in Supabase Auth (Authentication → Providers → GitHub) — uses the same OAuth app as #3 plus a callback added to Supabase

### 5. Railway account

For hosting the control-plane backend. Railway has an agent-ready MCP
server and GitHub-integrated deploys out of the box.

1. Sign up at https://railway.com
2. Install the CLI locally (`brew install railway` or `npm i -g @railway/cli`)
   and run `railway login`
3. For CI: Project Settings → Tokens → create a deploy token → save as
   `RAILWAY_TOKEN` GitHub secret on the repo

No project needs to exist yet — creating it is part of the 18.4 deploy work.
For interactive use, the Railway MCP server (see below) can create + deploy
projects directly from a Claude Code session.

### 6. PostHog project

Single source of truth for analytics + error tracking + logs (Phase 18.8).

1. Create project at https://posthog.com (or self-host)
2. From Project settings grab:
   - `POSTHOG_PROJECT_API_KEY` (write key, used in server + desktop)
   - `POSTHOG_PERSONAL_API_KEY` (read key, used by CI / MCP server / dashboards)
   - `POSTHOG_HOST` (`https://us.i.posthog.com` or `https://eu.i.posthog.com` or self-hosted URL)
3. In the project, enable **Error tracking** and **Session replay** features
4. Create a feature flag called `fastowl_debug` (off by default) that we can flip for verbose logging per user

---

## 🧰 Nice-to-have: MCP servers for Claude Code

Wiring these up lets Claude Code answer questions about GitHub state, DB schema, PostHog events without manual copy-pasting. Add them to `~/.claude/mcp_servers.json` or via `claude mcp add`.

### GitHub MCP

```bash
claude mcp add github -- npx -y @modelcontextprotocol/server-github
```

Needs a `GITHUB_PERSONAL_ACCESS_TOKEN` env var. Create one at https://github.com/settings/tokens with `repo` + `read:org` scopes.

### Supabase MCP (once #4 is set up)

Follow https://github.com/supabase-community/supabase-mcp for the install command. Needs `SUPABASE_ACCESS_TOKEN` (Supabase account level) and the project ref.

### PostHog MCP (once #6 is set up)

Not yet officially released but community versions exist — search `posthog mcp` on GitHub. Will use `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_HOST`.

### Railway MCP (once #5 is set up)

Official Railway MCP server — see https://docs.railway.com for the current
install command. Uses a Railway account token (same one you minted in #5).
Lets Claude Code create projects, deploy services, read logs, and manage
variables without leaving the editor.

### FastOwl MCP (local)

Exposes FastOwl's own task + backlog operations as Claude tools. Useful for letting a Claude Code session (or a child agent running inside a FastOwl task) create tasks, sync backlog sources, and kick the Continuous Build scheduler without dropping to a shell.

```bash
# build first
npm run build -w @fastowl/shared -w @fastowl/mcp-server

# register
claude mcp add fastowl -- node "$(pwd)/packages/mcp-server/dist/index.js"
```

Or add to `~/.claude/mcp_servers.json` manually:

```jsonc
{
  "mcpServers": {
    "fastowl": {
      "command": "node",
      "args": ["/absolute/path/to/fastowl/packages/mcp-server/dist/index.js"],
      "env": { "FASTOWL_API_URL": "http://localhost:4747" }
    }
  }
}
```

No external account needed — it talks to your local FastOwl backend. For agents FastOwl spawns, parent-injected env vars (`FASTOWL_WORKSPACE_ID`, `FASTOWL_TASK_ID`) mean the tools work argument-free.

After adding any MCP server, restart Claude Code. Verify with `/mcp` in the prompt.

---

## GitHub secrets (for CI)

Once the accounts above exist, add these to **Repo Settings → Secrets and variables → Actions** so CI can use them:

| Secret                          | Purpose                                   |
| ------------------------------- | ----------------------------------------- |
| `ANTHROPIC_API_KEY`             | Future: CI-run tests that hit the API    |
| `GITHUB_TOKEN`                  | Already provided by Actions               |
| `RAILWAY_TOKEN`                 | Deploy the backend on merges to main      |
| `DATABASE_URL`                  | drizzle-kit migrate step                  |
| `SUPABASE_SERVICE_ROLE_KEY`     | Server-side admin operations in migrations|
| `POSTHOG_PROJECT_API_KEY`       | Ship error events + build metrics         |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_ID_PASS` | macOS notarization (already in `publish.yml`) |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Code signing (same)                       |

---

## Local `.env` convention

Backend reads env vars on startup. To avoid exporting them every terminal, create `packages/backend/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_CLIENT_ID=Iv1.xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_REDIRECT_URI=http://localhost:4747/api/v1/github/callback
POSTHOG_PROJECT_API_KEY=phc_xxx     # optional, for when 18.8 lands
POSTHOG_HOST=https://us.i.posthog.com
```

And ensure `.gitignore` has `packages/backend/.env`. (If the backend doesn't yet load `.env` automatically, we'll add a `dotenv` import in Phase 18 cleanup — not critical yet.)

---

## What Claude Code cannot do for you

Everything in this doc that requires an account, a browser approval, or a credential you own. Specifically:
- Create Anthropic / GitHub / Supabase / Railway / PostHog accounts
- Approve OAuth apps
- Generate API keys
- Add GitHub repo secrets
- Install `claude` CLI binaries on remote VMs (we *can* automate this via the Phase 18.3 remote install flow once that ships, but not yet)

Everything else — schema, migrations, deploy configs, Dockerfiles, CI YAML — Claude Code can scaffold. Just share the credentials above when each phase starts.
