#!/bin/bash
# Enforce the async DB seam invariant.
#
# All runtime DB access goes through the async DbClient (getDbClient() from
# src/be/db.ts). Raw synchronous access — getDb(), statement.prepare(), or a
# bun:sqlite import — is only allowed in the seam itself and in boot-path code
# that runs once during startup (migrations, backfills, seeders), where the
# async seam buys nothing and sync is the safer shape.
#
# Allowlist source of truth: the stay-sync-boot classification from the async
# refactor (see PR for .asyncdb/txn-analysis.json). Finalize after Step 3.
#
# Note: `.prepare(` currently only ever appears on bun:sqlite handles in this
# repo; if a non-DB prepare() API ever appears, tighten the pattern instead of
# allowlisting the file.

set -euo pipefail

ALLOWLIST=(
  src/be/db.ts                                  # seam owner + initDb boot path
  src/be/db-client.ts                           # the seam implementation
  src/be/migrations/runner.ts                   # boot: SQL migrations
  src/be/oauth-encryption-backfill.ts           # boot: one-time backfill
  src/be/connection-bindings-blob-migration.ts  # boot: one-time migration
  src/be/seed-pricing.ts                        # boot: seeder
  src/be/rbac-roles.ts                          # boot: ensureRbacSeedsSynced
  src/be/asset-key-audit.ts                     # boot: startup audit (raw handle param)
  src/be/memory/providers/sqlite-store.ts       # constructor vec/FTS bootstrap; instance is boot-warmed by startMemoryGc()'s initial tick (async init = future decision)
  src/be/script-connections.ts                  # listScriptConnections feeds default parameter expressions (must stay sync)
  src/http/db-query.ts                          # read-only admin guard needs Statement.columnNames introspection
  src/http/db-query-shared.ts                   # same columnNames guard (in-process fallback path)
  src/http/db-query-bounded.ts                  # child process opens its own connection outside the seam; parent only reads getDb().filename
  src/http/assets.ts                            # passes the raw handle into the shared sync auditAssetKeys (wrapped in a client transaction at the call site)
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
