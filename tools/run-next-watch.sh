#!/usr/bin/env bash
set -euo pipefail

# run-next-watch.sh — Read-only watcher for a run folder.
# Emits JSONL events to stdout. Never mutates the filesystem.
# Only accepts relative paths under runs/ (e.g. runs/20260218_150000_TICKET-1).

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WATCH="$SCRIPT_DIR/skills/dev-pipeline/scripts/watch-run.js"

if [ -z "${1:-}" ]; then
  echo "Usage: ./tools/run-next-watch.sh runs/<run_folder> [--follow_audit] [--poll_ms N] [--max_events N]"
  echo ""
  echo "Read-only watcher. Emits JSONL events to stdout."
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

# Resolve and check existence
RESOLVED="$SCRIPT_DIR/$ARG"
if [ ! -d "$RESOLVED" ]; then
  echo '{"ok":false,"error":"run folder does not exist"}' >&2
  exit 1
fi

exec node "$WATCH" "$@"
