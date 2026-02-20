#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/_workspace.sh"

if [ ${#ARGS[@]} -eq 0 ]; then
  echo '{"ok":false,"error":"Usage: orchestrate-next.sh <run_folder>"}' >&2
  exit 1
fi

exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/dev-pipeline.js" orchestrate_one "${ARGS[0]}"
