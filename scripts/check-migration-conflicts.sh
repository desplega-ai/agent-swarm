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
# It also fails if a migration that exists on the base branch was renamed,
# renumbered, modified, or deleted. Migrations on main may already be applied
# in production; the runner tracks them by numeric version, so renumbering an
# applied file makes the runner silently skip the new file that took its number
# (incident 2026-06-10: 090_model_tiers skipped after 090→091 renumber).
#
# Runnable locally too: bash scripts/check-migration-conflicts.sh
# Base ref for the immutability check defaults to origin/main; override with
# MIGRATION_BASE_REF. Skipped (with a notice) when the base ref is missing or
# is not an ancestor of HEAD — CI enforces it on the PR merge ref.

set -euo pipefail

MIGRATIONS_DIR="apps/swarm/src/be/migrations"

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
  echo "Fix: renumber YOUR NEW migration to the next unused prefix and update"
  echo "any references to its filename. NEVER renumber the migration that is"
  echo "already on main — it may be applied in production databases."
  exit 1
fi

echo "Migration numbering check passed: all NNN prefixes are unique."

# Immutability check: migrations present on the base branch must exist in the
# working tree with identical content.
BASE_REF="${MIGRATION_BASE_REF:-origin/main}"

if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  echo "NOTE: base ref ${BASE_REF} not available — skipping migration immutability check."
  exit 0
fi

if ! git merge-base --is-ancestor "$BASE_REF" HEAD 2>/dev/null; then
  echo "NOTE: HEAD does not contain ${BASE_REF} (stale local branch?) — skipping"
  echo "migration immutability check. CI enforces it on the PR merge ref."
  exit 0
fi

VIOLATIONS=""
while read -r _mode _type base_hash base_path; do
  case "$base_path" in
    *.sql) ;;
    *) continue ;;
  esac
  if [ ! -f "$base_path" ]; then
    VIOLATIONS="${VIOLATIONS}  removed or renamed: ${base_path}\n"
  elif [ "$(git hash-object "$base_path")" != "$base_hash" ]; then
    VIOLATIONS="${VIOLATIONS}  modified: ${base_path}\n"
  fi
done < <(git ls-tree -r "$BASE_REF" -- "$MIGRATIONS_DIR")

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: applied migrations were renamed, modified, or deleted!"
  echo ""
  echo "These migrations exist on ${BASE_REF} and may already be applied in"
  echo "production databases. The migration runner tracks applied migrations by"
  echo "numeric version, so renumbering or editing one makes the runner silently"
  echo "skip or mismatch it. Migrations are forward-only and immutable once merged."
  echo ""
  echo -e "$VIOLATIONS"
  echo "Fix: restore these files exactly as they are on ${BASE_REF} and put your"
  echo "changes in a NEW migration with the next unused NNN prefix."
  exit 1
fi

echo "Migration immutability check passed: no base-branch migrations were changed."
