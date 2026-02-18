#!/usr/bin/env bash
set -euo pipefail

# run-next-stop.sh — Signal the autonomous runner to stop at next step boundary.
# Creates a .stop file in the run folder. Safe and idempotent.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${1:-}" ]; then
  echo "Usage: ./tools/run-next-stop.sh <run_folder>"
  echo ""
  echo "Creates <run_folder>/.stop — the runner will stop at the next step boundary."
  exit 1
fi

RUN_FOLDER="$1"

# Resolve relative paths against workspace root
if [[ "$RUN_FOLDER" != /* ]]; then
  RUN_FOLDER="$SCRIPT_DIR/$RUN_FOLDER"
fi

if [ ! -d "$RUN_FOLDER" ]; then
  echo '{"ok":false,"error":"run folder does not exist"}' >&2
  exit 1
fi

touch "$RUN_FOLDER/.stop"
echo "{\"ok\":true,\"action\":\"stop_signal_created\",\"path\":\"$RUN_FOLDER/.stop\"}"
