#!/bin/bash
# Enforce the Worker/API DB boundary invariant.
#
# The API server is the sole owner of the SQLite database. Worker-side code
# must NEVER import database modules directly — workers communicate with the
# API exclusively via HTTP.
#
# Worker-side paths (post apps-split + package extraction):
#   apps/cli/src/commands/  apps/cli/src/hooks/  apps/cli/src/cli.tsx
#   packages/harness/src/providers/  packages/harness/src/claude.ts  packages/prompt-templates/
#   packages/scripts/src/scripts-runtime/
#   plugin/opencode-plugins/  (runs inside the opencode subprocess in the worker)
#
# NOTE: apps/cli/src/stdio.ts is intentionally NOT scanned — it is the stdio MCP
# server transport (a server entry, peer of apps/api/src/http.ts), so it is
# allowed to touch @swarm/storage (e.g. closeDb), unlike worker code.
#
# Forbidden patterns:
#   - import/from be/db (direct DB module)
#   - import/from bun:sqlite (raw SQLite driver)

set -euo pipefail

WORKER_PATHS=(
  apps/cli/src/commands/
  apps/cli/src/hooks/
  apps/cli/src/cli.tsx
  packages/harness/src/providers/
  packages/harness/src/claude.ts
  packages/prompt-templates/
  packages/scripts/src/scripts-runtime/
  plugin/opencode-plugins/
)

VIOLATIONS=""

for path in "${WORKER_PATHS[@]}"; do
  if [ ! -e "$path" ]; then
    continue
  fi

  # Check for imports from be/db
  MATCHES=$(grep -rn --include='*.ts' --include='*.tsx' -E 'from\s+["\x27].*be/db' "$path" 2>/dev/null || true)
  if [ -n "$MATCHES" ]; then
    VIOLATIONS="${VIOLATIONS}${MATCHES}\n"
  fi

  # Check for bun:sqlite imports
  MATCHES=$(grep -rn --include='*.ts' --include='*.tsx' -E '(import|from)\s+["\x27]bun:sqlite' "$path" 2>/dev/null || true)
  if [ -n "$MATCHES" ]; then
    VIOLATIONS="${VIOLATIONS}${MATCHES}\n"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Worker/API DB boundary violation detected!"
  echo ""
  echo "Worker-side code must NOT import database modules."
  echo "Workers communicate with the API via HTTP — they never access the DB directly."
  echo ""
  echo "Violations:"
  echo -e "$VIOLATIONS"
  echo ""
  echo "Fix: Move DB-dependent logic to src/be/, src/http/, or src/tools/ (API-side),"
  echo "or extract pure functions to a shared module (e.g., src/prompts/)."
  exit 1
fi

echo "Worker/API DB boundary check passed."
