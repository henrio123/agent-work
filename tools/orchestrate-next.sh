#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${1:-}" ]; then
  echo '{"ok":false,"error":"Usage: orchestrate-next.sh <run_folder>"}' >&2
  exit 1
fi

exec node "$SCRIPT_DIR/skills/dev-pipeline/scripts/dev-pipeline.js" orchestrate_one "$1"
