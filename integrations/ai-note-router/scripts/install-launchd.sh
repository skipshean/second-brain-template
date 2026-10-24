#!/bin/zsh
# Install the router LaunchAgent(s) with this vault's real path and your username.
# Usage: scripts/install-launchd.sh [router|task-report|log-rotate ...]   (default: router)
set -euo pipefail

SCRIPT_DIR="${0:a:h}"
VAULT_ROOT="${SCRIPT_DIR:h:h:h}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS_DIR" "$HOME/Library/Logs"

jobs=("$@")
[ ${#jobs[@]} -eq 0 ] && jobs=(router)

for job in "${jobs[@]}"; do
  src="$SCRIPT_DIR/com.secondbrain.$job.plist"
  dst="$AGENTS_DIR/com.secondbrain.$job.plist"
  [ -f "$src" ] || { echo "No such job: $job" >&2; exit 1; }
  sed -e "s#/path/to/second-brain#$VAULT_ROOT#g" -e "s#/Users/YOUR_USERNAME#$HOME#g" "$src" > "$dst"
  launchctl bootout "gui/$(id -u)" "$dst" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
  launchctl enable "gui/$(id -u)/com.secondbrain.$job"
  echo "Installed com.secondbrain.$job -> $dst"
done
