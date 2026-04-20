#!/usr/bin/env bash
# Completely remove the FastOwl daemon from this machine.
#
# Ships inside the .app bundle (Contents/Resources/scripts/) and also
# lives in the repo at scripts/fastowl-uninstall.sh. The in-app
# "Uninstall FastOwl daemon and quit…" menu item does the same work
# via the localDaemon helpers, so you only need this script if you:
#   - already deleted FastOwl.app before uninstalling the daemon, or
#   - want to remove the daemon from a CLI-only headless install.
#
# After running this: the launchd / systemd user service is gone, the
# bundled binary is gone, and ~/.fastowl/daemon.json is gone. The
# FastOwl backend's record of the env remains (it's hosted state);
# delete it from the app's Settings → Environments if you no longer
# want that machine paired.

set -euo pipefail

LABEL="com.fastowl.daemon"
UNIT_NAME="fastowl-daemon"

case "$(uname -s)" in
  Darwin)
    UID_NUM=$(id -u)
    launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
    rm -f "${HOME}/Library/LaunchAgents/${LABEL}.plist"
    rm -rf "${HOME}/Library/Application Support/FastOwl/daemon"
    rm -rf "${HOME}/Library/Logs/FastOwl"
    ;;
  Linux)
    systemctl --user disable --now "${UNIT_NAME}" 2>/dev/null || true
    rm -f "${HOME}/.config/systemd/user/${UNIT_NAME}.service"
    systemctl --user daemon-reload 2>/dev/null || true
    rm -rf "${HOME}/.local/share/fastowl/daemon"
    ;;
  *)
    echo "Unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

rm -f "${HOME}/.fastowl/daemon.json"
# Only remove the directory if it's now empty — user may have other
# fastowl state we shouldn't clobber (e.g. CLI auth config).
rmdir "${HOME}/.fastowl" 2>/dev/null || true

echo "FastOwl daemon uninstalled. Delete /Applications/FastOwl.app (macOS)"
echo "or your install of the desktop app to finish the cleanup."
