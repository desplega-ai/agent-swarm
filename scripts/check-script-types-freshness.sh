#!/usr/bin/env bash
# Fails when the checked-in script SDK types (src/scripts-runtime/types/*.d.ts)
# drift from their source of truth. The .d.ts files are GENERATED — the type
# text lives in src/be/scripts/typecheck.ts and is emitted by
# scripts/bundle-script-types.ts. Never edit the .d.ts files directly.
set -euo pipefail
cd "$(dirname "$0")/.."

# The bundler itself forces a fresh throwaway DB (ignoring any inherited
# DATABASE_PATH), so build:script-types and this check see the same
# deterministic clean-DB baseline.
bun scripts/bundle-script-types.ts

if [ -n "$(git diff --name-only src/scripts-runtime/types/)" ]; then
  echo "::error::script SDK types are out of date! Run 'bun run build:script-types' and commit the changes. Source of truth: src/be/scripts/typecheck.ts — never edit the .d.ts files directly."
  git diff --stat src/scripts-runtime/types/
  exit 1
fi

echo "script SDK types are up to date."
