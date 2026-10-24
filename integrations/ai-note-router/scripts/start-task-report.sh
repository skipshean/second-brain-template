#!/bin/zsh
set -euo pipefail

REPO_ROOT="${0:a:h}/../../.."
cd "$REPO_ROOT"

if [ -f ".env" ]; then
  set -a
  source ".env"
  set +a
fi

python3 integrations/linear-vault-sync/report_tasks.py \
  --vault-path "$REPO_ROOT" \
  --mode daily \
  --include-linear \
  --post-slack
