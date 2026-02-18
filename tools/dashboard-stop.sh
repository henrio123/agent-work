#!/usr/bin/env bash
set -euo pipefail

PORT=18790

PIDS=$(lsof -ti:"$PORT" 2>/dev/null || true)
if [ -z "$PIDS" ]; then
  echo "No process on port $PORT"
  exit 0
fi

echo "$PIDS" | xargs kill
echo "Stopped (port $PORT freed)"
