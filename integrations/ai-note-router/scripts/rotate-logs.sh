#!/bin/bash
# Size-cap and prune the Second Brain LaunchAgent logs.
#
# launchd appends to StandardOutPath/StandardErrorPath forever and never rotates,
# so this script does it. For every ~/Library/Logs/SecondBrain-*.log over the cap:
#   1. keep the newest SB_LOG_MAX_MB of it as a gzipped archive (older bytes are dropped)
#   2. truncate the live file in place (launchd holds it open, so we cannot mv it)
# Then prune archives beyond SB_LOG_KEEP per log, or older than SB_LOG_MAX_AGE_DAYS.
#
# Quiet unless it acts. Safe to run as often as you like and by hand:
#   scripts/rotate-logs.sh            # rotate/prune whatever is over the limits
#   SB_LOG_MAX_MB=1 scripts/rotate-logs.sh
#
# Env overrides:
#   SB_LOG_DIR           default: ~/Library/Logs
#   SB_LOG_MAX_MB        default: 10   (live log cap, and size of the tail kept in an archive)
#   SB_LOG_KEEP          default: 3    (archives kept per log)
#   SB_LOG_MAX_AGE_DAYS  default: 14   (archives older than this are deleted)
set -euo pipefail

LOG_DIR="${SB_LOG_DIR:-$HOME/Library/Logs}"
MAX_MB="${SB_LOG_MAX_MB:-10}"
KEEP="${SB_LOG_KEEP:-3}"
MAX_AGE_DAYS="${SB_LOG_MAX_AGE_DAYS:-14}"
MAX_BYTES=$((MAX_MB * 1024 * 1024))

[[ -d "$LOG_DIR" ]] || exit 0

stamp="$(date +%Y%m%d-%H%M%S)"

for log in "$LOG_DIR"/SecondBrain-*.log; do
  [[ -f "$log" ]] || continue
  size="$(wc -c < "$log" | tr -d ' ')"
  if (( size > MAX_BYTES )); then
    tail -c "$MAX_BYTES" "$log" | gzip -c > "$log.$stamp.gz"
    : > "$log"
    echo "rotated $(basename "$log"): $((size / 1024 / 1024)) MB -> archive $(basename "$log").$stamp.gz"
  fi
done

# Prune archives: anything past the newest $KEEP per log, then anything too old.
for log in "$LOG_DIR"/SecondBrain-*.log; do
  [[ -f "$log" ]] || continue
  # ls -t = newest first; names are timestamped and contain no spaces
  # shellcheck disable=SC2012
  # The `|| true` matters: with no archives yet, ls fails and pipefail+set -e would abort the script.
  { ls -1t "$log".*.gz 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    echo "pruned $(basename "$old") (keep newest $KEEP)"
  done
done
find "$LOG_DIR" -maxdepth 1 -name 'SecondBrain-*.log.*.gz' -mtime "+$MAX_AGE_DAYS" -print -delete 2>/dev/null \
  | while read -r old; do echo "pruned $(basename "$old") (older than ${MAX_AGE_DAYS}d)"; done || true
