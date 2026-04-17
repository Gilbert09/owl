# Running FastOwl against an SSH VM

This walks through pointing FastOwl at a remote machine (VM, dev box, homelab
server) over SSH and running Continuous Build tasks there.

The desktop app + backend still run on your **laptop** — only the Claude
agents (and the code they touch) run on the **VM**.

```
┌──────── laptop ─────────┐           ┌────── remote VM ──────┐
│  FastOwl desktop app    │           │                       │
│  @fastowl/backend       │  ──SSH──▶ │  $ claude (in PTY)    │
│    - scheduler           │           │  $ fastowl task ...   │
│    - backlog service     │           │  $ git / npm / etc.   │
└──────────────────────────┘           └───────────────────────┘
```

---

## 1. On your laptop

Make sure the backend is running and reachable from the VM. By default it
binds `localhost:4747` which is NOT reachable over SSH unless you tunnel
(see step 3) or bind to a LAN address.

```bash
# From the monorepo root
npm install
npm run build -w @fastowl/shared
npm run dev:backend    # http://localhost:4747
# ...and in another terminal:
npm run dev:desktop
```

---

## 2. On the VM

You need three things on the VM: **git + node**, **Claude CLI**, and the
**`fastowl` CLI**.

```bash
# Node 18+ is required; verify:
node --version

# Install Claude CLI (see https://docs.anthropic.com/claude/docs/claude-cli
# for the latest instructions). Quick install:
curl -fsSL https://claude.ai/install.sh | sh
claude --version
claude auth login      # follow the browser flow

# Install the fastowl CLI. Easiest: clone the repo and link.
git clone git@github.com:Gilbert09/owl.git ~/fastowl
cd ~/fastowl
npm install
npm run build -w @fastowl/shared
npm run build -w @fastowl/cli
sudo npm link -w @fastowl/cli
fastowl --version
```

Clone whatever project repos you want FastOwl to work on:

```bash
mkdir -p ~/projects && cd ~/projects
git clone git@github.com:your-org/your-repo.git
# configure git user / push creds as you normally would
```

---

## 3. Networking: let the VM reach the FastOwl backend

Child Claudes running on the VM may want to call back to the parent via
`fastowl task create ...`. They need `FASTOWL_API_URL` pointing at your
laptop's backend.

Pick **one** of these approaches.

### Option A — SSH reverse tunnel (recommended for dev)

When you SSH in, forward 4747 back. Add this to `~/.ssh/config` on your
**laptop**:

```
Host fastowl-vm
  HostName vm1.example.com       # or IP
  User your-user
  RemoteForward 4747 localhost:4747
```

Then every shell on the VM sees `http://localhost:4747` pointing at your
laptop's backend. Add this to `~/.bashrc` on the **VM**:

```bash
export FASTOWL_API_URL="http://localhost:4747"
```

### Option B — Bind backend to LAN, use your laptop's IP

On the **laptop**, start the backend bound to your LAN interface:

```bash
HOST=0.0.0.0 npm run dev:backend
# backend is now at http://<your-laptop-ip>:4747
```

On the **VM**, add to `~/.bashrc`:

```bash
export FASTOWL_API_URL="http://192.168.1.42:4747"   # your laptop IP
```

Firewall / router permitting.

### Option C — Run the backend on the VM itself

Skip local backend. Run `npm run dev:backend` on the VM and point the
desktop app's WebSocket at it (requires code change to desktop's hardcoded
`http://localhost:4747`). **Not recommended yet** — desktop currently
assumes backend is local. Tracked in Phase 18.6.

---

## 4. In the FastOwl desktop app

1. Open **Settings → Environments → Add Environment**
2. Pick **SSH**. Fill in:
   - Name: `my-vm`
   - Host: the SSH hostname (matches your `~/.ssh/config`)
   - Port: 22
   - Username: your remote user
   - Auth: **Agent** (recommended — uses your local `ssh-agent`) or **Key**
     (point at `~/.ssh/id_ed25519` or similar)
   - Working directory: `~/projects` (or wherever you clone repos)
3. Click **Add** → wait for the status dot to turn green.

Click **Test** on the environment card to confirm. If it fails, check
`ssh <host>` works from your shell first — FastOwl just wraps that.

---

## 5. Wire up a repository

Under **Settings → Workspace → Watched Repositories**, add the repo you
cloned on the VM (e.g. `your-org/your-repo`). The GitHub integration
needs to be connected first for repo picking to work.

Tasks will run against `~/projects/your-repo` on the VM. (Hardcoded for
now — making this configurable is tracked under Phase 9.)

---

## 6. Try a one-shot task

1. **Tasks → New Task → Code Writing**
2. Prompt: *"Add a docstring to the main function in src/index.ts"*
3. Environment: pick your SSH env
4. Repository: pick the repo you added
5. **Start**

You should see the terminal stream output from the VM. If Claude asks a
question, type in the input box at the bottom. When it's done, hit
**Ready for Review**, then **Approve** or **Reject** from the task detail
view.

---

## 7. Turn on Continuous Build

Once a one-shot works end-to-end, point Continuous Build at a TODO doc:

1. **Settings → Continuous Build**
2. Enable the toggle (start with `maxConcurrent: 1`, `requireApproval: On`)
3. **Add source**:
   - File path: `/home/<you>/projects/your-repo/TODO.md` (absolute path on
     the VM)
   - Section: optional — name a heading (e.g. `Priority Queue`)
   - Environment: pick your SSH env
4. Click the sync button on the new source. You should see items appear
   with their status.
5. Click **Run scheduler** — FastOwl spawns a task for the first unblocked
   item. Review it. Approve. Watch the next one kick off.

---

## Troubleshooting

**"Not connected to environment"**: the SSH link dropped. FastOwl retries
every 5s; check your `ssh <host>` works and the connection isn't being
killed by a firewall / NAT timeout. Try `keepaliveInterval` in
`~/.ssh/config`.

**`claude: command not found`** in the task terminal: the Claude CLI isn't
on the remote shell's PATH. Confirm by `ssh <host> 'which claude'`. If it
only exists under a specific profile, ensure `.bashrc` (or the login
shell's rc file) puts it on PATH for non-interactive sessions too.

**`fastowl: command not found`** when a child Claude tries to spawn a
sub-task: repeat step 2. Verify `ssh <host> 'which fastowl'`.

**Child Claude calls `fastowl task create` and gets `ECONNREFUSED`**: your
`FASTOWL_API_URL` isn't routing back to the backend. Walk through step 3
again and confirm `curl $FASTOWL_API_URL/health` from the VM returns
`{"status":"ok"}`.

**Backlog sync fails with `Failed to read ...`**: the path you gave is
wrong for the VM, or the file doesn't exist. `ssh <host> 'cat /path/to/TODO.md'`
to verify.

**Task runs forever / gets stuck**: manually stop from the UI. Check the
agent's terminal output for a prompt Claude is waiting on. If the agent
row is orphaned (no active process), restart the backend — the stuck-task
recovery logic resets `in_progress` tasks back to `queued`.
