#!/usr/bin/env bash
set -euo pipefail

# run-next-resume.sh — Remove stop signal so the autonomous runner can continue.
# Removes .stop file from the run folder. Safe and idempotent.
# Only accepts relative paths under .claw/runs/ (e.g. .claw/runs/20260218_150000_TICKET-1).

source "$(dirname "$0")/_workspace.sh"

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "Usage: ./tools/run-next-resume.sh .claw/runs/<run_folder>"
  echo ""
  echo "Removes .claw/runs/<run_folder>/.stop — the runner will continue on next invocation."
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

rm -f "$RESOLVED/.stop"
echo "{\"ok\":true,\"action\":\"stop_signal_removed\",\"run_folder\":\"$ARG\"}"
