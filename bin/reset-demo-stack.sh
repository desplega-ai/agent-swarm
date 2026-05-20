#!/usr/bin/env bash
# reset-demo-stack.sh — spin up a local swarm stack and seed realistic demo fixtures.
#
# Idempotent: safe to run multiple times. Stops any existing API/UI processes,
# starts fresh ones, waits for the API to be healthy, then wipes + re-seeds the DB.
#
# Prerequisites:
#   - bun (https://bun.sh) installed
#   - pnpm installed (for the UI)
#   - pm2 installed globally: npm install -g pm2
#
# Usage:
#   bin/reset-demo-stack.sh
#   API_PORT=3013 UI_PORT=5274 bin/reset-demo-stack.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Ensure pm2 uses a writable home directory
export PM2_HOME="${PM2_HOME:-${HOME}/.pm2}"
mkdir -p "${PM2_HOME}"

API_PORT="${API_PORT:-3013}"
UI_PORT="${UI_PORT:-5274}"
API_URL="http://localhost:${API_PORT}"
UI_URL="http://localhost:${UI_PORT}"

log() { echo "  [reset-demo-stack] $*"; }
section() { echo; echo "=== $* ==="; }

# ---------------------------------------------------------------------------
# 1. Tear down existing API / UI processes
# ---------------------------------------------------------------------------

section "Stopping existing services"

pm2 stop swarm-api swarm-ui 2>/dev/null && log "pm2 services stopped" || log "no pm2 services running"
pm2 delete swarm-api swarm-ui 2>/dev/null || true

# Ensure no lingering processes on the ports
fuser -k "${API_PORT}/tcp" 2>/dev/null && log "killed stale API on :${API_PORT}" || true
fuser -k "${UI_PORT}/tcp" 2>/dev/null && log "killed stale UI on :${UI_PORT}" || true

# ---------------------------------------------------------------------------
# 2. Install dependencies (fast — bun caches)
# ---------------------------------------------------------------------------

section "Installing dependencies"

bun install --silent
(cd ui && pnpm install --silent 2>/dev/null) || log "pnpm install skipped (pnpm not available)"

# ---------------------------------------------------------------------------
# 3. Start API (runs directly via bun — uses local SQLite DB)
# ---------------------------------------------------------------------------

section "Starting API on :${API_PORT}"

pm2 start bun \
  --name swarm-api \
  --no-autorestart \
  -- src/http.ts

# Wait for API health
log "Waiting for API health..."
TIMEOUT=60
ELAPSED=0
until curl -sf "${API_URL}/health" >/dev/null 2>&1; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "ERROR: API failed to start within ${TIMEOUT}s" >&2
    pm2 logs swarm-api --lines 20 >&2
    exit 1
  fi
done
log "API healthy ✓"

# ---------------------------------------------------------------------------
# 4. Seed demo fixtures (wipes existing data)
# ---------------------------------------------------------------------------

section "Seeding demo fixtures"

bun run seed:clean
log "DB seeded ✓"

# ---------------------------------------------------------------------------
# 5. Start UI
# ---------------------------------------------------------------------------

section "Starting UI on :${UI_PORT}"

# Run vite directly (bypasses the `portless` wrapper in `pnpm dev`)
pm2 start "${REPO_ROOT}/ui/node_modules/.bin/vite" \
  --name swarm-ui \
  --no-autorestart \
  --cwd "${REPO_ROOT}/ui" \
  --interpreter bash

# Give the UI a few seconds to compile
log "Waiting for UI dev server..."
sleep 6

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo
echo "✅  Demo stack ready"
echo "   API : ${API_URL}"
echo "   UI  : ${UI_URL}"
echo
echo "   pm2 logs swarm-api   — API logs"
echo "   pm2 logs swarm-ui    — UI logs"
echo "   pm2 stop swarm-api swarm-ui  — stop everything"
echo
echo "   Run: cd assets/release-recorder && bun run.ts"
