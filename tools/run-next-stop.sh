#!/usr/bin/env bash
set -euo pipefail

# run-next-stop.sh — Signal the autonomous runner to stop at next step boundary.
# Creates a .stop file in the run folder. Safe and idempotent.
# Only accepts relative paths under .claw/runs/ (e.g. .claw/runs/20260218_150000_TICKET-1).

source "$(dirname "$0")/_workspace.sh"

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "Usage: ./tools/run-next-stop.sh .claw/runs/<run_folder>"
  echo ""
  echo "Creates .claw/runs/<run_folder>/.stop — the runner will stop at the next step boundary."
  echo "Argument must be a relative path starting with .claw/runs/."
  exit 1
fi

ARG="${ARGS[0]}"

# Refuse absolute paths
if [[ "$ARG" == /* ]]; then
  echo '{"ok":false,"error":"absolute paths not allowed — use .claw/runs/<folder>"}' >&2
  exit 1
fi

# Must start with .claw/runs/
if [[ "$ARG" != .claw/runs/* ]]; then
  echo '{"ok":false,"error":"path must start with .claw/runs/"}' >&2
  exit 1
fi

# Refuse traversal
if [[ "$ARG" == *..* ]]; then
  echo '{"ok":false,"error":"path traversal not allowed"}' >&2
  exit 1
fi

# Resolve: join workspace root + relative arg (safe after traversal check)
RESOLVED="$WORKSPACE_ROOT/$ARG"

if [ ! -d "$RESOLVED" ]; then
  echo '{"ok":false,"error":"run folder does not exist"}' >&2
  exit 1
fi

touch "$RESOLVED/.stop"
echo "{\"ok\":true,\"action\":\"stop_signal_created\",\"run_folder\":\"$ARG\",\"stop_path\":\"$RESOLVED/.stop\"}"
