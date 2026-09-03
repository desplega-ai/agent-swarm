#!/bin/bash
# Enforce the black-box boundary for the standalone E2E runner.

set -euo pipefail

E2E_PATH="scripts/e2e"
VIOLATIONS=""

if [ -d "$E2E_PATH" ]; then
  MATCHES=$(grep -rn --include='*.ts' -E \
    '(from|import[[:space:]]*\()[[:space:]]*["\x27](\.\./)+(src|apps|packages)(/|["\x27])|from[[:space:]]+["\x27](bun:sqlite|@swarm/)|import[[:space:]]*["\x27](bun:sqlite|@swarm/)' \
    "$E2E_PATH" 2>/dev/null || true)
  if [ -n "$MATCHES" ]; then
    VIOLATIONS="${VIOLATIONS}${MATCHES}\n"
  fi
fi

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: E2E black-box boundary violation detected!"
  echo ""
  echo "scripts/e2e may use only HTTP, MCP, Bun, and node builtins."
  echo ""
  echo "Violations:"
  echo -e "$VIOLATIONS"
  exit 1
fi

echo "E2E black-box boundary check passed."

