#!/bin/bash
# Enforce the Worker/API DB boundary invariant.
#
# The API server is the sole owner of the SQLite database. Worker-side code
# must NEVER import database modules directly — workers communicate with the
# API exclusively via HTTP.
#
# Worker-side paths:
#   apps/swarm/src/commands/  apps/swarm/src/hooks/  apps/swarm/src/providers/  apps/swarm/src/prompts/  apps/swarm/src/scripts-runtime/  apps/swarm/src/cli.tsx  apps/swarm/src/claude.ts
#   plugin/opencode-plugins/  (runs inside the opencode subprocess in the worker)
#
# Forbidden patterns:
#   - import/from be/db (direct DB module)
#   - import/from bun:sqlite (raw SQLite driver)

set -euo pipefail

WORKER_PATHS=(
  apps/swarm/src/commands/
  apps/swarm/src/hooks/
  apps/swarm/src/providers/
  apps/swarm/src/prompts/
  apps/swarm/src/scripts-runtime/
  apps/swarm/src/utils/
  apps/swarm/src/cli.tsx
  apps/swarm/src/claude.ts
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
  echo "Fix: Move DB-dependent logic to apps/swarm/src/be/, apps/swarm/src/http/, or apps/swarm/src/tools/ (API-side),"
  echo "or extract pure functions to a shared module (e.g., apps/swarm/src/prompts/)."
  exit 1
fi

echo "Worker/API DB boundary check passed."
