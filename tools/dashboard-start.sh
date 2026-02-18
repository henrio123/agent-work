#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DASHBOARD="$SCRIPT_DIR/skills/dev-pipeline/scripts/dashboard.js"
PORT=18790

if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "Dashboard already running on port $PORT"
  echo "http://localhost:$PORT"
  exit 0
fi

node "$DASHBOARD" &
echo "http://localhost:$PORT"
