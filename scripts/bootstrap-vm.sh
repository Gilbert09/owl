#!/usr/bin/env bash
# bootstrap-vm.sh — Provision a remote machine (typically a Linux VM) so it
# can run FastOwl tasks. Idempotent — safe to re-run.
#
# Installs, in order:
#   1. Node.js 22 (via nvm if user doesn't have Node ≥ 18)
#   2. Claude CLI
#   3. FastOwl repo checkout + @fastowl/cli (linked as `fastowl`)
#   4. Environment variables in ~/.bashrc (FASTOWL_API_URL)
#
# Does NOT handle:
#   - Claude authentication (interactive browser flow — run `claude auth login`
#     manually after this script completes)
#   - Cloning the repos you want FastOwl to work on — that's up to you,
#     because those are your repos, not FastOwl's.
#
# Usage (typically run via SSH from your laptop):
#
#   ssh <vm-host> bash -s -- [options] < scripts/bootstrap-vm.sh
#
# Options:
#   --api-url URL       FastOwl backend URL the VM should call back to
#                       (default: http://localhost:4747, which only works if
#                        you've set up an SSH reverse tunnel)
#   --branch REF        Git ref of FastOwl to check out (default: main)
#   --install-dir PATH  Where to clone FastOwl (default: ~/fastowl)
#   --skip-node         Don't touch Node (assume it's set up)
#   --skip-claude       Don't install Claude CLI
#   --dry-run           Print what would happen without doing it
#
# Example:
#   ssh vm1 bash -s -- --api-url https://fastowl.yourhost.com \
#     < scripts/bootstrap-vm.sh

set -euo pipefail

# ---------- defaults ----------
API_URL="${FASTOWL_API_URL:-http://localhost:4747}"
BRANCH="main"
INSTALL_DIR="$HOME/fastowl"
SKIP_NODE="false"
SKIP_CLAUDE="false"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)       API_URL="$2"; shift 2 ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --install-dir)   INSTALL_DIR="$2"; shift 2 ;;
    --skip-node)     SKIP_NODE="true"; shift ;;
    --skip-claude)   SKIP_CLAUDE="true"; shift ;;
    --dry-run)       DRY_RUN="true"; shift ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# \{0,1\}//' | head -40
      exit 0 ;;
    *)
      echo "unknown option: $1" >&2
      exit 2 ;;
  esac
done

# ---------- helpers ----------
log()  { echo ">>> $*" >&2; }
run()  { log "$*"; [[ "$DRY_RUN" == "true" ]] || "$@"; }
have() { command -v "$1" >/dev/null 2>&1; }

log "FastOwl VM bootstrap starting"
log "  API URL:     $API_URL"
log "  FastOwl dir: $INSTALL_DIR"
log "  Branch:      $BRANCH"
log "  Dry run:     $DRY_RUN"

# ---------- 1. Node.js ----------
if [[ "$SKIP_NODE" == "true" ]]; then
  log "Skipping Node install (--skip-node)"
else
  NODE_OK="false"
  if have node; then
    node_major=$(node --version | sed -E 's/^v([0-9]+)\..*/\1/')
    if [[ "$node_major" -ge 18 ]]; then
      log "Node $(node --version) already installed, skipping"
      NODE_OK="true"
    else
      log "Node $(node --version) too old, upgrading via nvm"
    fi
  fi
  if [[ "$NODE_OK" != "true" ]]; then
    if ! have nvm; then
      log "Installing nvm..."
      # shellcheck disable=SC2016
      run bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
    fi
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
    run nvm install 22
    run nvm alias default 22
  fi
fi

# ---------- 2. Claude CLI ----------
if [[ "$SKIP_CLAUDE" == "true" ]]; then
  log "Skipping Claude CLI install (--skip-claude)"
elif have claude; then
  log "Claude CLI $(claude --version 2>&1 | head -1) already installed, skipping"
else
  log "Installing Claude CLI (npm global)..."
  # Using the npm package is the simplest, universal path. An alternative is
  # the curl installer, but it varies by platform.
  run npm install -g @anthropic-ai/claude-code
fi

# ---------- 3. FastOwl repo + CLI ----------
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  log "Cloning FastOwl to $INSTALL_DIR"
  run mkdir -p "$(dirname "$INSTALL_DIR")"
  run git clone git@github.com:Gilbert09/owl.git "$INSTALL_DIR"
  run git -C "$INSTALL_DIR" checkout "$BRANCH"
else
  log "FastOwl already cloned at $INSTALL_DIR, pulling latest"
  run git -C "$INSTALL_DIR" fetch origin
  run git -C "$INSTALL_DIR" checkout "$BRANCH"
  run git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
fi

log "Installing FastOwl dependencies..."
run bash -c "cd \"$INSTALL_DIR\" && npm install"
run bash -c "cd \"$INSTALL_DIR\" && npm run build -w @fastowl/shared"
run bash -c "cd \"$INSTALL_DIR\" && npm run build -w @fastowl/cli"
run bash -c "cd \"$INSTALL_DIR\" && npm run build -w @fastowl/mcp-server"

log "Linking fastowl CLI globally..."
# npm link -w works when the workspace directory is the cwd in some npm versions
run bash -c "cd \"$INSTALL_DIR/packages/cli\" && npm link"

# ---------- 4. Environment variables in ~/.bashrc ----------
BASHRC="$HOME/.bashrc"
MARK_BEGIN="# >>> fastowl >>>"
MARK_END="# <<< fastowl <<<"

if [[ -f "$BASHRC" ]] && grep -qF "$MARK_BEGIN" "$BASHRC"; then
  log "Replacing existing fastowl block in $BASHRC"
  if [[ "$DRY_RUN" != "true" ]]; then
    tmp=$(mktemp)
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; next }
      !skip   { print }
    ' "$BASHRC" > "$tmp"
    mv "$tmp" "$BASHRC"
  fi
fi

log "Appending fastowl env block to $BASHRC"
if [[ "$DRY_RUN" != "true" ]]; then
  cat >> "$BASHRC" <<EOF
$MARK_BEGIN
# Managed by fastowl bootstrap-vm.sh — safe to remove or re-run the script.
export FASTOWL_API_URL="$API_URL"
$MARK_END
EOF
fi

# ---------- 5. Verify ----------
log "Verifying install..."
run bash -lc 'command -v node && node --version'
run bash -lc 'command -v claude && claude --version 2>&1 | head -1'
run bash -lc 'command -v fastowl && fastowl --version'

log ""
log "✓ VM bootstrap complete."
log ""
log "Next steps (manual, for now):"
log "  1. Authenticate Claude on this VM:"
log "       claude  (opens a browser flow on first run)"
log "  2. Clone any project repos you want FastOwl to work on:"
log "       git clone git@github.com:your-org/your-repo.git ~/projects/your-repo"
log "  3. On your laptop, open FastOwl → Settings → Environments → Add SSH"
log "     and point it at this host."
log ""
log "To verify end-to-end: ssh back in, \`fastowl ping\` should print 'ok'."
