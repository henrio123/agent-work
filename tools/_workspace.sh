#!/usr/bin/env bash
# _workspace.sh — Shared helper for parsing --workspace flag.
#
# Source this file at the top of any tool wrapper:
#   source "$(dirname "$0")/_workspace.sh"
#
# After sourcing:
#   WORKSPACE_ROOT is set (from --workspace flag, WORKSPACE_ROOT env, or SCRIPT_DIR)
#   ARGS contains remaining arguments with --workspace consumed

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Parse --workspace from arguments
ARGS=()
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$SCRIPT_DIR}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      WORKSPACE_ROOT="$2"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

export WORKSPACE_ROOT
