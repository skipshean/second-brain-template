#!/bin/zsh
# Start the full Fireflies ingest stack:
# - AI Note Router (port 3333)
# - Fireflies adapter (port 3000)
# - Cloudflare tunnel -> adapter
#
# Used by LaunchAgent; run from repo root so dotenv and paths resolve.
set -euo pipefail

SCRIPT_DIR="${0:a:h}"
VAULT_ROOT="${SCRIPT_DIR}/../../.."
cd "$VAULT_ROOT"

# Load .env from vault root so CLOUDFLARE_TUNNEL_TOKEN and other vars are available
# (LaunchAgent does not inherit the user shell environment)
if [[ -f ".env" ]]; then
  set -o allexport
  source ".env"
  set +o allexport
fi

# Keep logs size-capped even if the rotation LaunchAgent isn't installed (see rotate-logs.sh).
/bin/bash "${SCRIPT_DIR}/rotate-logs.sh" || true

# cloudflared logs every request at info level; warn keeps ~/Library/Logs small.
export TUNNEL_LOGLEVEL="${TUNNEL_LOGLEVEL:-warn}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install with: brew install cloudflared" >&2
  exit 1
fi

echo "Starting AI Note Router on localhost:3333..."
npm run serve &
ROUTER_PID=$!

echo "Starting Fireflies adapter on localhost:3000..."
npm run serve-fireflies-adapter &
ADAPTER_PID=$!

cleanup() {
  echo "Shutting down ingest stack..."
  kill "$ROUTER_PID" "$ADAPTER_PID" "$TUNNEL_PID" 2>/dev/null || true
  wait "$ROUTER_PID" "$ADAPTER_PID" "$TUNNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Preferred durable option: Cloudflare named tunnel token from .env
# (keeps a stable hostname configured in Cloudflare).
if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  echo "Starting cloudflared using CLOUDFLARE_TUNNEL_TOKEN (durable tunnel)..."
  cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
else
  echo "CLOUDFLARE_TUNNEL_TOKEN not set; starting quick tunnel (URL rotates on restart)."
  cloudflared tunnel --url http://localhost:3000 &
fi
TUNNEL_PID=$!

# Keep process alive while all children are alive.
while true; do
  if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
    echo "Router process exited unexpectedly" >&2
    exit 1
  fi
  if ! kill -0 "$ADAPTER_PID" 2>/dev/null; then
    echo "Adapter process exited unexpectedly" >&2
    exit 1
  fi
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "Cloudflared process exited unexpectedly" >&2
    exit 1
  fi
  sleep 2
done
