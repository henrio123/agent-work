#!/usr/bin/env bash
exec node "$(dirname "$0")/../skills/dev-pipeline/scripts/agent-state.js" "$@"
