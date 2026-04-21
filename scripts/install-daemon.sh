#!/usr/bin/env bash
# install-daemon.sh — Provision the FastOwl daemon on a remote Linux VM
# (systemd) or macOS host (launchd). Idempotent. Pairs with the hosted
# backend using a one-shot pairing token, then persists the long-lived
# device token so subsequent boots reconnect automatically.
#
# Designed to be piped from the backend:
#
#   curl -fsSL https://backend/daemon/install.sh \
#     | bash -s -- --backend-url https://backend \
#                  --pairing-token <TOKEN>
#
# Options:
#   --backend-url URL     FastOwl backend URL the daemon should dial (required)
#   --pairing-token TOK   One-shot pairing token minted by the backend (required)
#   --branch REF          Git ref of FastOwl to check out (default: main)
#   --install-dir PATH    Where to clone FastOwl (default: /opt/fastowl on Linux,
#                         $HOME/fastowl on macOS)
#   --user USER           User the daemon should run as (default: $USER)
#   --skip-node           Don't touch Node (assume node >= 18 present)
#   --no-service          Pair once but don't install a systemd/launchd unit
#   --dry-run             Print what would happen without executing
#
# What this DOES:
#   - Installs Node 22 if missing (NodeSource on Debian/Ubuntu, nvm as fallback)
#   - Clones/updates the FastOwl repo into --install-dir
#   - Builds @fastowl/shared and @fastowl/daemon
#   - Runs the daemon once with the pairing token to exchange for a device token
#   - Writes a systemd unit (Linux) or launchd plist (macOS) that keeps the
#     daemon running
#
# What this does NOT do:
#   - Install Claude CLI — that's bootstrap-vm.sh's job. The daemon itself
#     doesn't need Claude to pair; Claude is only needed when a task spawns.
#   - Clone any of your project repos.

set -euo pipefail

# ---------- defaults ----------
BACKEND_URL=""
PAIRING_TOKEN=""
BRANCH="main"
INSTALL_DIR=""
RUN_USER="${SUDO_USER:-$USER}"
SKIP_NODE="false"
NO_SERVICE="false"
DRY_RUN="false"

OS_KIND=""
case "$(uname -s)" in
  Linux*)  OS_KIND="linux" ;;
  Darwin*) OS_KIND="darwin" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

if [[ -z "$INSTALL_DIR" ]]; then
  if [[ "$OS_KIND" == "linux" ]]; then
    INSTALL_DIR="/opt/fastowl"
  else
    INSTALL_DIR="$HOME/fastowl"
  fi
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-url)    BACKEND_URL="$2"; shift 2 ;;
    --pairing-token)  PAIRING_TOKEN="$2"; shift 2 ;;
    --branch)         BRANCH="$2"; shift 2 ;;
    --install-dir)    INSTALL_DIR="$2"; shift 2 ;;
    --user)           RUN_USER="$2"; shift 2 ;;
    --skip-node)      SKIP_NODE="true"; shift ;;
    --no-service)     NO_SERVICE="true"; shift ;;
    --dry-run)        DRY_RUN="true"; shift ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# \{0,1\}//' | head -40
      exit 0 ;;
    *)
      echo "unknown option: $1" >&2
      exit 2 ;;
  esac
done

# ---------- validate ----------
if [[ -z "$BACKEND_URL" ]]; then
  echo "error: --backend-url is required" >&2
  exit 2
fi
if [[ -z "$PAIRING_TOKEN" ]]; then
  echo "error: --pairing-token is required" >&2
  exit 2
fi

log()  { echo ">>> $*" >&2; }
run()  { log "$*"; [[ "$DRY_RUN" == "true" ]] || eval "$@"; }
have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [[ "$OS_KIND" == "linux" && "$EUID" -ne 0 ]]; then
  if have sudo; then SUDO="sudo"; fi
fi

log "FastOwl daemon install starting"
log "  OS:          $OS_KIND"
log "  Backend URL: $BACKEND_URL"
log "  Install dir: $INSTALL_DIR"
log "  Run user:    $RUN_USER"
log "  Branch:      $BRANCH"
log "  Dry run:     $DRY_RUN"

# ---------- 1. Node.js ----------
install_node_linux() {
  if have apt-get; then
    log "Installing Node 22 via NodeSource (apt)..."
    run "curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -"
    run "$SUDO apt-get install -y nodejs"
    return
  fi
  if have yum; then
    log "Installing Node 22 via NodeSource (yum)..."
    run "curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -"
    run "$SUDO yum install -y nodejs"
    return
  fi
  log "No apt/yum detected, falling back to nvm..."
  if ! have nvm; then
    run "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  fi
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
  run "nvm install 22 && nvm alias default 22"
}

install_node_darwin() {
  if have brew; then
    log "Installing Node via Homebrew..."
    run "brew install node@22 || brew install node"
    return
  fi
  log "Homebrew not installed; falling back to nvm..."
  if ! have nvm; then
    run "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  fi
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
  run "nvm install 22 && nvm alias default 22"
}

if [[ "$SKIP_NODE" == "true" ]]; then
  log "Skipping Node install (--skip-node)"
else
  node_ok="false"
  if have node; then
    node_major=$(node --version | sed -E 's/^v([0-9]+)\..*/\1/')
    if [[ "$node_major" -ge 18 ]]; then
      log "Node $(node --version) already installed, skipping"
      node_ok="true"
    else
      log "Node $(node --version) too old, upgrading"
    fi
  fi
  if [[ "$node_ok" != "true" ]]; then
    if [[ "$OS_KIND" == "linux" ]]; then
      install_node_linux
    else
      install_node_darwin
    fi
  fi
fi

# Ensure `git` is on the Linux path (needed for the clone step below).
# node-pty's build toolchain was dropped in Slice 4c; the daemon now
# only needs stock Node + git.
if [[ "$OS_KIND" == "linux" ]] && have apt-get; then
  if ! have git; then
    log "Installing git..."
    run "$SUDO apt-get install -y git"
  fi
fi

# ---------- 2. Clone + build ----------
log "Ensuring $INSTALL_DIR exists (owner=$RUN_USER)..."
if [[ "$OS_KIND" == "linux" && "$INSTALL_DIR" == /opt/* ]]; then
  run "$SUDO mkdir -p $(dirname "$INSTALL_DIR")"
  run "$SUDO chown -R $RUN_USER:$RUN_USER $(dirname "$INSTALL_DIR")"
else
  run "mkdir -p $(dirname "$INSTALL_DIR")"
fi

if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  log "Cloning FastOwl..."
  run "git clone https://github.com/Gilbert09/owl.git $INSTALL_DIR"
else
  log "Repo already at $INSTALL_DIR, pulling latest"
  run "git -C $INSTALL_DIR fetch origin"
fi
run "git -C $INSTALL_DIR checkout $BRANCH"
run "git -C $INSTALL_DIR pull --ff-only origin $BRANCH"

log "Installing npm deps + building shared + daemon..."
run "cd $INSTALL_DIR && npm install --no-audit --no-fund"
run "cd $INSTALL_DIR && npm run build -w @fastowl/shared"
run "cd $INSTALL_DIR && npm run build -w @fastowl/daemon"

# Stamp a version.json alongside the built daemon so the running
# process can report its real SHA in the hello message. The daemon
# reads this on startup via src/version.ts. Without it, the daemon
# falls back to "<pkgVersion>-dev" and the desktop can't tell
# whether it's stale.
INSTALL_SHA="$(cd "$INSTALL_DIR" && git rev-parse HEAD 2>/dev/null || echo unknown)"
INSTALL_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run "printf '%s\n' '{\"sha\":\"$INSTALL_SHA\",\"builtAt\":\"$INSTALL_BUILT_AT\"}' > $INSTALL_DIR/packages/daemon/version.json"

# ---------- 3. Pair once (foreground) ----------
CONFIG_DIR_LINUX="/etc/fastowl"
CONFIG_DIR_USER="$HOME/.fastowl"
CONFIG_FILE=""
if [[ "$OS_KIND" == "linux" ]]; then
  CONFIG_FILE="$CONFIG_DIR_LINUX/daemon.json"
  run "$SUDO mkdir -p $CONFIG_DIR_LINUX"
  run "$SUDO chown $RUN_USER:$RUN_USER $CONFIG_DIR_LINUX"
  run "$SUDO chmod 0700 $CONFIG_DIR_LINUX"
else
  CONFIG_FILE="$CONFIG_DIR_USER/daemon.json"
  run "mkdir -p $CONFIG_DIR_USER && chmod 0700 $CONFIG_DIR_USER"
fi

DAEMON_ENTRY="$INSTALL_DIR/packages/daemon/dist/index.js"

log "Pairing with the backend (one-shot foreground run)..."
if [[ "$DRY_RUN" != "true" ]]; then
  # Run daemon in background; watch config file for deviceToken to appear,
  # then kill it and move on to the service install. Timeout 60s.
  set +e
  (node "$DAEMON_ENTRY" \
       --backend-url "$BACKEND_URL" \
       --pairing-token "$PAIRING_TOKEN" \
       >/tmp/fastowl-daemon-pair.log 2>&1) &
  PAIR_PID=$!

  paired="false"
  for _ in $(seq 1 60); do
    if [[ -f "$CONFIG_FILE" ]] && grep -q '"deviceToken"' "$CONFIG_FILE"; then
      paired="true"
      break
    fi
    if ! kill -0 "$PAIR_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  # Stop the foreground daemon; the service will restart it below.
  kill -TERM "$PAIR_PID" 2>/dev/null || true
  wait "$PAIR_PID" 2>/dev/null || true
  set -e

  if [[ "$paired" != "true" ]]; then
    echo "error: daemon failed to pair within 60s. Last log:" >&2
    tail -n 30 /tmp/fastowl-daemon-pair.log >&2 || true
    exit 1
  fi
  log "Paired successfully (device token stored at $CONFIG_FILE)."
fi

# ---------- 4. systemd / launchd ----------
if [[ "$NO_SERVICE" == "true" ]]; then
  log "Skipping service install (--no-service). Start manually with:"
  log "  node $DAEMON_ENTRY --backend-url $BACKEND_URL"
  exit 0
fi

NODE_BIN="$(command -v node || echo /usr/bin/node)"

if [[ "$OS_KIND" == "linux" ]]; then
  UNIT_PATH="/etc/systemd/system/fastowl-daemon.service"
  log "Writing systemd unit at $UNIT_PATH"
  UNIT_CONTENTS="[Unit]
Description=FastOwl daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Environment=HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
Environment=FASTOWL_BACKEND_URL=$BACKEND_URL
ExecStart=$NODE_BIN $DAEMON_ENTRY --backend-url $BACKEND_URL
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
"
  if [[ "$DRY_RUN" != "true" ]]; then
    printf '%s' "$UNIT_CONTENTS" | $SUDO tee "$UNIT_PATH" >/dev/null
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now fastowl-daemon.service
    $SUDO systemctl restart fastowl-daemon.service
  else
    log "(dry-run) would write unit and systemctl enable --now"
  fi

  log ""
  log "✓ Daemon installed and running via systemd."
  log "  Status: systemctl status fastowl-daemon"
  log "  Logs:   journalctl -u fastowl-daemon -f"
else
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_PATH="$PLIST_DIR/dev.fastowl.daemon.plist"
  log "Writing launchd plist at $PLIST_PATH"
  run "mkdir -p $PLIST_DIR"
  PLIST_CONTENTS="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>dev.fastowl.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DAEMON_ENTRY</string>
    <string>--backend-url</string>
    <string>$BACKEND_URL</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/fastowl-daemon.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/fastowl-daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FASTOWL_BACKEND_URL</key><string>$BACKEND_URL</string>
  </dict>
</dict>
</plist>
"
  if [[ "$DRY_RUN" != "true" ]]; then
    printf '%s' "$PLIST_CONTENTS" > "$PLIST_PATH"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
  else
    log "(dry-run) would write plist and launchctl load"
  fi

  log ""
  log "✓ Daemon installed via launchd."
  log "  Logs: tail -f /tmp/fastowl-daemon.err.log"
fi
