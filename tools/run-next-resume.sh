#!/usr/bin/env bash
set -euo pipefail

# run-next-resume.sh — Remove stop signal so the autonomous runner can continue.
# Removes .stop file from the run folder. Safe and idempotent.
# Only accepts relative paths under runs/ (e.g. runs/20260218_150000_TICKET-1).

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNS_DIR="$SCRIPT_DIR/runs"

if [ -z "${1:-}" ]; then
  echo "Usage: ./tools/run-next-resume.sh runs/<run_folder>"
  echo ""
  echo "Removes runs/<run_folder>/.stop — the runner will continue on next invocation."
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

rm -f "$RESOLVED/.stop"
echo "{\"ok\":true,\"action\":\"stop_signal_removed\",\"run_folder\":\"$ARG\"}"
