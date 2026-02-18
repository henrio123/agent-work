#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-18790}"
STATE_DIR="$SCRIPT_DIR/tools/.state"
PIDFILE="$STATE_DIR/dashboard.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "No dashboard pidfile found (not started by dashboard-start.sh)"
  exit 0
fi

PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped dashboard (pid $PID, port $PORT freed)"
else
  echo "Dashboard process $PID already exited"
fi

rm -f "$PIDFILE"
