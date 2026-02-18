#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DASHBOARD="$SCRIPT_DIR/skills/dev-pipeline/scripts/dashboard.js"
PORT="${PORT:-18790}"
STATE_DIR="$SCRIPT_DIR/tools/.state"
PIDFILE="$STATE_DIR/dashboard.pid"

mkdir -p "$STATE_DIR"

# Check if our dashboard is already running via pidfile
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Dashboard already running (pid $OLD_PID)"
    echo "http://localhost:$PORT"
    exit 0
  fi
  # Stale pidfile
  rm -f "$PIDFILE"
fi

# Check if something else is using the port
EXISTING_PID=$(lsof -ti:"$PORT" 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  echo "Port $PORT already in use by pid $EXISTING_PID (not our dashboard)" >&2
  exit 1
fi

node "$DASHBOARD" --port="$PORT" &
DASH_PID=$!
echo "$DASH_PID" > "$PIDFILE"
echo "http://localhost:$PORT"
