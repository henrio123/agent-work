#!/usr/bin/env bash
set -euo pipefail

# run-next-resume.sh — Remove stop signal so the autonomous runner can continue.
# Removes .stop file from the run folder. Safe and idempotent.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${1:-}" ]; then
  echo "Usage: ./tools/run-next-resume.sh <run_folder>"
  echo ""
  echo "Removes <run_folder>/.stop — the runner will continue on next invocation."
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

rm -f "$RUN_FOLDER/.stop"
echo "{\"ok\":true,\"action\":\"stop_signal_removed\",\"path\":\"$RUN_FOLDER/.stop\"}"
