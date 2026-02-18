#!/usr/bin/env bash
set -euo pipefail

# run-next-stop.sh — Signal the autonomous runner to stop at next step boundary.
# Creates a .stop file in the run folder. Safe and idempotent.
# Only accepts relative paths under runs/ (e.g. runs/20260218_150000_TICKET-1).

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNS_DIR="$SCRIPT_DIR/runs"

if [ -z "${1:-}" ]; then
  echo "Usage: ./tools/run-next-stop.sh runs/<run_folder>"
  echo ""
  echo "Creates runs/<run_folder>/.stop — the runner will stop at the next step boundary."
  echo "Argument must be a relative path starting with runs/."
  exit 1
fi

ARG="$1"

# Refuse absolute paths
if [[ "$ARG" == /* ]]; then
  echo '{"ok":false,"error":"absolute paths not allowed — use runs/<folder>"}' >&2
  exit 1
fi

# Must start with runs/
if [[ "$ARG" != runs/* ]]; then
  echo '{"ok":false,"error":"path must start with runs/"}' >&2
  exit 1
fi

# Refuse traversal
if [[ "$ARG" == *..* ]]; then
  echo '{"ok":false,"error":"path traversal not allowed"}' >&2
  exit 1
fi

# Resolve: join workspace root + relative arg (safe after traversal check)
RESOLVED="$SCRIPT_DIR/$ARG"

if [ ! -d "$RESOLVED" ]; then
  echo '{"ok":false,"error":"run folder does not exist"}' >&2
  exit 1
fi

touch "$RESOLVED/.stop"
echo "{\"ok\":true,\"action\":\"stop_signal_created\",\"run_folder\":\"$ARG\",\"stop_path\":\"$RESOLVED/.stop\"}"
