#!/bin/bash
# Enforce the async DB seam invariant.
#
# Runtime DB access uses the async DbClient (getDbClient() from src/be/db.ts).
# Raw synchronous access belongs to the seam and main-thread boot code.
# Boot includes migrations, backfills, seeders, and startup audits.
# Explorer introspection, its explicit synchronous fallback, and metrics
# retain the separate read-only connection exceptions listed below.
#
# This script is the allowlist source of truth. See Phase 4 in
# thoughts/taras/plans/2026-11-12-worker-sqlite-db-client.md.
#
# Note: `.prepare(` currently only ever appears on bun:sqlite handles in this
# repo; if a non-DB prepare() API ever appears, tighten the pattern instead of
# allowlisting the file.

set -euo pipefail

ALLOWLIST=(
  src/be/db/db-worker.ts                        # owns the runtime Worker connection
  src/be/db.ts                                  # boot: synchronous prompt-template helpers
  src/be/db/runtime.ts                          # singleton lifecycle + async client seam owner
  src/be/db-client.ts                           # the seam implementation
  src/be/migrations/runner.ts                   # boot: SQL migrations
  src/be/oauth-encryption-backfill.ts           # boot: one-time backfill
  src/be/connection-bindings-blob-migration.ts  # boot: one-time migration
  src/be/seed-pricing.ts                        # boot: seeder
  src/be/rbac-roles.ts                          # boot: ensureRbacSeedsSynced
  src/be/boot-seeds.ts                          # boot: once-per-handle guards around the two seeders (getDb() only identifies the handle)
  src/be/db/prompt-templates-boot.ts             # boot: synchronous prompt listing for startup seeding
  src/be/asset-key-audit.ts                     # boot: startup audit (raw handle param)
  src/http/db-query.ts                          # read-only admin guard needs Statement.columnNames introspection
  src/http/db-query-shared.ts                   # same columnNames guard (in-process fallback path)
  src/http/db-query-bounded.ts                  # child process opens its own connection outside the seam; parent only reads getDb().filename
)

PATTERN='(\bgetDb\s*\(|\.prepare\s*\(|from\s+["'\'']bun:sqlite)'

MATCHES=$(grep -rn --include='*.ts' --include='*.tsx' -E "$PATTERN" src/ 2>/dev/null | grep -v '^src/tests/' || true)

# Comment lines and type-only imports do not grant runtime DB access.
MATCHES=$(echo "$MATCHES" | grep -vE '^[^:]+:[0-9]+:\s*(//|\*)' || true)
MATCHES=$(echo "$MATCHES" | grep -v 'import type' || true)

for allowed in "${ALLOWLIST[@]}"; do
  MATCHES=$(echo "$MATCHES" | grep -v "^${allowed}:" || true)
done
MATCHES=$(echo "$MATCHES" | grep -v '^\s*$' || true)

if [ -n "$MATCHES" ]; then
  echo "ERROR: raw synchronous DB access outside the seam/boot allowlist!"
  echo ""
  echo "Runtime code must use the async seam: getDbClient() from src/be/db."
  echo "  await getDbClient().query<Row>(sql, params)  // SELECT all"
  echo "  await getDbClient().get<Row>(sql, params)    // first row | null"
  echo "  await getDbClient().run(sql, params)         // DML/DDL"
  echo "  await getDbClient().transaction(async (tx) => ...)"
  echo ""
  echo "Violations:"
  echo "$MATCHES"
  echo ""
  echo "If this is genuinely boot-path (runs once during startup before any"
  echo "concurrency), add the file to ALLOWLIST in this script with a comment."
  exit 1
fi

echo "Async DB seam check passed."
