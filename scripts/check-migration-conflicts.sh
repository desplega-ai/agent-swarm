#!/bin/bash
# Detect DB migration numbering conflicts.
#
# Migrations live in src/be/migrations/NNN_descriptive_name.sql and are applied
# forward-only in numeric NNN order. Two PRs branched off the same main can each
# add a migration with the same NNN; in isolation each PR looks fine, so the
# collision slips past review and lands two files sharing one NNN.
#
# This script globs the checked-out tree and fails if any NNN prefix appears on
# more than one file. On GitHub pull_request events the merge ref is checked out
# (PR merged into base), so both a base-vs-branch collision and a within-PR
# duplicate surface as two files sharing one NNN — no diff-against-main needed.
#
# Runnable locally too: bash scripts/check-migration-conflicts.sh

set -euo pipefail

MIGRATIONS_DIR="src/be/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "ERROR: migrations directory not found: $MIGRATIONS_DIR"
  exit 1
fi

declare -A PREFIX_FILES
CONFLICTS=""

shopt -s nullglob
for file in "$MIGRATIONS_DIR"/*.sql; do
  base=$(basename "$file")
  prefix=$(echo "$base" | grep -oE '^[0-9]+' || true)
  if [ -z "$prefix" ]; then
    echo "ERROR: migration file has no leading numeric prefix: $base"
    exit 1
  fi
  if [ -n "${PREFIX_FILES[$prefix]:-}" ]; then
    PREFIX_FILES[$prefix]="${PREFIX_FILES[$prefix]} $base"
    CONFLICTS="${CONFLICTS}${prefix}\n"
  else
    PREFIX_FILES[$prefix]="$base"
  fi
done
shopt -u nullglob

if [ -n "$CONFLICTS" ]; then
  echo "ERROR: DB migration numbering conflict detected!"
  echo ""
  echo "Multiple migration files share the same NNN prefix. Migrations are"
  echo "applied in numeric order, so duplicate prefixes are ambiguous."
  echo ""
  echo "Conflicting migrations:"
  while read -r prefix; do
    [ -z "$prefix" ] && continue
    echo "  $prefix: ${PREFIX_FILES[$prefix]}"
  done < <(echo -e "$CONFLICTS" | sort -u)
  echo ""
  echo "Fix: renumber your migration to the next unused prefix and update any"
  echo "references to its filename."
  exit 1
fi

echo "Migration numbering check passed: all NNN prefixes are unique."
