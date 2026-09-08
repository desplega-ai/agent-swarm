#!/bin/bash
# Enforce the async DB seam invariant.
#
# All runtime DB access goes through the async DbClient (getDbClient() from
# src/be/db.ts). Raw synchronous access — getDb(), statement.prepare(), or a
# bun:sqlite import — is only allowed in the seam itself and in boot-path code
# that runs once during startup (migrations, backfills, seeders), where the
# async seam buys nothing and sync is the safer shape.
#
# Allowlist source of truth: per-file justifications live HERE, next to the
# entries CI reviews — not in scratch files (see #1227). Every entry carries
# an inline justification comment with a classification tag (enforced below).
#
# Legend:
#   [boot-permanent]  — runs once during startup before any traffic
#   (migrations, backfills, seeders, seam internals); raw sync is the
#   intended shape forever.
#   [needs-redesign]  — runtime (or boot-called but Postgres-blocking) surface
#   that must leave the list; each entry names its redesign sketch. Tracked
#   under #1227; exit criterion is boot-permanent entries only — the
#   precondition for a worker-thread driver or a Postgres client behind
#   the seam.
#
# Review rule: a new allowlist entry requires an inline justification comment
# with a classification tag. The UNJUSTIFIED check below fails CI otherwise.
#
# Note: `.prepare(` currently only ever appears on bun:sqlite handles in this
# repo; if a non-DB prepare() API ever appears, tighten the pattern instead of
# allowlisting the file.

set -euo pipefail

ALLOWLIST=(
  # NOTE (src/be/db.ts): seam owner + initDb boot path (CHECK-constraint rebuild,
  # ensureAgentProfileColumns, seedContextVersions, autoEncryptLegacyPlaintextSecrets)
  # plus getDb/getDbClient/closeDb themselves. The prompt-template chain in this
  # file (getPromptTemplates/upsertPromptTemplate/resetPromptTemplateToDefault/
  # resolvePromptTemplate, DI-injected into sync resolveTemplate() with ~19 sync
  # callers) still needs an async resolver seam — tracked under #1227.
  src/be/db.ts                                  # [boot-permanent] seam owner + initDb boot path
  src/be/db-client.ts                           # [boot-permanent] the seam implementation itself
  src/be/migrations/runner.ts                   # [boot-permanent] migration runner, runs before any traffic
  src/be/oauth-encryption-backfill.ts           # [boot-permanent] one-time boot backfill
  src/be/connection-bindings-blob-migration.ts  # [boot-permanent] one-time boot migration
  src/be/seed-pricing.ts                        # [boot-permanent] boot seeder (prepared insert + raw transaction)
  # ensureRbacSeedsSynced holds eight prepared-statement objects that cannot cross
  # the seam, and CREATE_USER_DEFAULT_ROLE_TRIGGER_SQL is a multi-statement body the
  # client's single-statement run() cannot execute. Options: multi-statement exec on
  # the seam (boot-gated), or split the trigger SQL.
  src/be/rbac-roles.ts                          # [needs-redesign] boot-called seed sync; prepared statements + multi-statement trigger
  # Shared sync auditAssetKeys(database) helper, called from initDb AND two runtime
  # paths (db.ts prompt-template transaction, http/assets.ts:252). Split boot vs
  # runtime entry points.
  src/be/asset-key-audit.ts                     # [needs-redesign] shared sync audit helper (boot + runtime callers)
  # vec/FTS bootstrap runs in the constructor (cannot await); helpers shared with
  # async read paths. Instance is boot-warmed by startMemoryGc()'s initial tick.
  # Needs a lazy async-init redesign of the store.
  src/be/memory/providers/sqlite-store.ts       # [needs-redesign] constructor vec/FTS bootstrap; needs lazy async init
  # listScriptConnections feeds default parameter expressions in typecheck.ts (a
  # default-parameter expression cannot await). Hoist the defaults into the call
  # sites; async twin listScriptConnectionsAsync already exists for migrated callers.
  src/be/script-connections.ts                  # [needs-redesign] sync list for typecheck defaults; hoist defaults to call sites
  # In-process fallback path: read-only guard needs Statement.columnNames
  # introspection, which the seam deliberately does not expose. Options: narrow
  # read-only introspection on the client, or route through the bounded child.
  src/http/db-query-shared.ts                   # [needs-redesign] columnNames guard (in-process fallback path)
  # Bounded child-process query path owns its own connection outside the seam;
  # parent only reads getDb().filename. Decide: stays exempt by design or routes
  # the filename through the seam.
  src/http/db-query-bounded.ts                  # [needs-redesign] child owns its connection; exempt-by-design decision pending
  # Passes the raw handle into the shared sync auditAssetKeys (wrapped in a client
  # transaction at the call site). Resolves when auditAssetKeys splits boot vs runtime.
  src/http/assets.ts                            # [needs-redesign] raw handle into shared sync audit helper
)

# Review-rule enforcement (#1227): every ALLOWLIST entry line in THIS file must
# carry an inline justification comment with a classification tag. CI invokes
# this script as `bash scripts/check-async-db-seam.sh` from the repo root, so
# $0 resolves to this file.
ALLOWLIST_UNJUSTIFIED=$(grep -E '^[[:space:]]*src/' "$0" | grep -vE '#.*\[(boot-permanent|needs-redesign)\]' || true)
if [ -n "$ALLOWLIST_UNJUSTIFIED" ]; then
  echo "ERROR: allowlist entries without a justification comment!"
  echo ""
  echo "Every ALLOWLIST entry in scripts/check-async-db-seam.sh must carry an"
  echo "inline justification comment with a classification tag (see the legend"
  echo "at the top of this file):"
  echo "  src/path/to/file.ts  # [boot-permanent|needs-redesign] reason..."
  echo ""
  echo "Unjustified entries:"
  echo "$ALLOWLIST_UNJUSTIFIED"
  exit 1
fi

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
  echo "The comment must include a classification tag: # [boot-permanent] or"
  echo "# [needs-redesign] plus the reason (see the legend above; #1227)."
  exit 1
fi

echo "Async DB seam check passed."
