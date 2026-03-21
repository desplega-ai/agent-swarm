#!/bin/bash
# Enforce the Worker/API DB boundary invariant.
#
# The API server is the sole owner of the SQLite database. Worker-side code
# must NEVER import database modules directly — workers communicate with the
# API exclusively via HTTP.
#
# Worker-side paths:
#   src/commands/  src/hooks/  src/providers/  src/prompts/  src/cli.tsx  src/claude.ts
#
# Forbidden patterns:
#   - import/from be/db (direct DB module)
#   - import/from bun:sqlite (raw SQLite driver)

set -euo pipefail

WORKER_PATHS=(
  src/commands/
  src/hooks/
  src/providers/
  src/prompts/
  src/cli.tsx
  src/claude.ts
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
