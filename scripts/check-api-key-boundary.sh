#!/bin/bash
# Enforce centralized swarm API-key resolution.
#
# All swarm code must read the API key via getApiKey() / setApiKey() from
# src/utils/api-key.ts. Direct access to `process.env.API_KEY` or
# `process.env.AGENT_SWARM_API_KEY` outside the helper is forbidden so we keep
# a single source of truth for the env precedence
# (AGENT_SWARM_API_KEY > API_KEY) and can later evolve it (e.g. swap to a
# `~/.config/agent-swarm/config.json` lookup) without hunting through 30+
# call sites.
#
# Forbidden patterns (in src/, excluding the helper and tests; this includes
# worker-side runtime code under src/scripts-runtime/):
#   - process.env.API_KEY
#   - process.env.AGENT_SWARM_API_KEY
#
# Tests (`src/tests/**`) are exempt — they intentionally mutate the raw env
# to exercise back-compat with the legacy variable name.
#
# Standalone scripts in `scripts/` and integration scripts are NOT scanned;
# they can grow their own conventions without touching production code.

set -euo pipefail

ALLOW_FILES=(
  src/utils/api-key.ts
)

# Scan production source only — exclude tests.
MATCHES=$(grep -rn --include='*.ts' --include='*.tsx' \
  -E 'process\.env\.(AGENT_SWARM_)?API_KEY' \
  src/ 2>/dev/null \
  | grep -v '^src/tests/' \
  | grep -v '^src/utils/api-key\.ts:' \
  || true)

if [ -n "$MATCHES" ]; then
  echo "ERROR: Direct API_KEY env access detected outside src/utils/api-key.ts."
  echo ""
  echo "All swarm code must use getApiKey() / setApiKey() from src/utils/api-key.ts"
  echo "so the env-var precedence (AGENT_SWARM_API_KEY > API_KEY) stays centralized."
  echo ""
  echo "Violations:"
  echo "$MATCHES"
  echo ""
  echo "Fix: replace with"
  echo "    import { getApiKey } from '<...>/utils/api-key';"
  echo "    const apiKey = getApiKey();"
  exit 1
fi

echo "API_KEY boundary check passed."
