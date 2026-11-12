#!/usr/bin/env bash
# `bun run check:local`: one local check loop for agents and humans, run before a push.
#
#   1. bun install --frozen-lockfile
#   2. Biome (read-only, like CI's `bun run lint`) on changed files it lints in CI
#   3. anti-slop Oxlint rules (`bun run lint:slop`, whole scope, about 5 s)
#   4. `bun check` (Bun's built-in type checker) on the root project, plus
#      apps/ui when it changed
#   5. drift: only the generators whose inputs changed (CI's trigger filters);
#      fails when regenerating changes a checked-in output
#   6. test:root on the tests affected by the change (scripts/pre-push-tests.sh
#      scoping, including its full-suite fallbacks)
#   7. E2E Contract on the scenarios the change reaches (scripts/e2e/scope.ts);
#      the full suite when the diff cannot be scoped, nothing when it reaches
#      neither the API nor the runner. `--skip-e2e` skips it.
#
# "Changed" means committed since the merge-base with origin/main, plus
# uncommitted and untracked edits. Stops at the first failing step and prints
# the wall time of every step that ran.
#
# Secrets scanning stays with the prek pre-push hooks; this script does not run
# it. CI stays authoritative: tsc 5, Biome over the whole lint scope, the
# sharded suite, the full strict E2E run, UI E2E, Docker, and the boundary
# checks in runbooks/ci.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

skip_e2e=0
for arg in "$@"; do
  case "$arg" in
    --skip-e2e) skip_e2e=1 ;;
    *)
      echo "usage: bun run check:local [--skip-e2e]" >&2
      exit 2
      ;;
  esac
done

# Directories CI runs Biome on: root `bun run lint` plus apps/ui's own lint.
BIOME_SCOPE='^(src/|apps/evals/|apps/ui/|packages/ui-e2e/|packages/model-routing/)'

# Wall time per step: each step() closes the one before it; the EXIT trap closes
# the last one (also on failure) and prints the table.
step_name=""
step_started=0
timings=()
end_step() {
  [[ -n "$step_name" ]] || return 0
  local took=$((SECONDS - step_started))
  timings+=("$(printf '%5ds  %s' "$took" "$step_name")")
  printf '[check] %s: %ds\n' "$step_name" "$took"
  step_name=""
}
step() {
  end_step
  step_name=$1
  step_started=$SECONDS
  printf '\n[check] %s\n' "$1"
}
summary() {
  local code=$?
  end_step
  printf '\n[check] wall time per step (total %ds)\n' "$SECONDS"
  printf '%s\n' "${timings[@]}"
  exit "$code"
}
trap summary EXIT

# Drift: run a generator only when its inputs changed (path filters taken from
# detect-changes in .github/workflows/merge-gate.yml), then fail when it changed
# a checked-in output. Outputs already regenerated but not yet committed pass
# here with a reminder; CI checks the pushed tree.
#   drift <name> <trigger regex> <outputs, space-separated> <command...>
outputs_state() {
  # shellcheck disable=SC2086  # $1 is a space-separated pathspec list.
  {
    git diff --binary HEAD -- $1
    git ls-files -z --others --exclude-standard -- $1 | xargs -0 -r sha1sum
  } | sha1sum
}
drift() {
  local name=$1 trigger=$2 outputs=$3
  shift 3
  grep -qE "$trigger" <<<"$changed" || return 0
  step "drift: $name"
  local before
  before=$(outputs_state "$outputs")
  "$@"
  if [[ "$(outputs_state "$outputs")" != "$before" ]]; then
    echo "[check] drift: '$*' changed checked-in output. Commit it:" >&2
    # shellcheck disable=SC2086
    git status --short -- $outputs >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  if [[ -n "$(git status --porcelain -- $outputs)" ]]; then
    echo "[check] drift: $name output is current but not committed yet:"
    # shellcheck disable=SC2086
    git status --short -- $outputs
  fi
}

step "bun install --frozen-lockfile"
bun install --frozen-lockfile

base=$(git merge-base origin/main HEAD 2>/dev/null || git rev-parse HEAD)
changed=$(
  {
    git diff --name-only --diff-filter=d "$base"
    git ls-files --others --exclude-standard
  } | sort -u
)

lint_files=$(grep -E "$BIOME_SCOPE" <<<"$changed" || true)
if [[ -n "$lint_files" ]]; then
  step "biome check ($(wc -l <<<"$lint_files" | tr -d ' ') changed files)"
  tr '\n' '\0' <<<"$lint_files" |
    xargs -0 bunx biome check --no-errors-on-unmatched --files-ignore-unknown=true
else
  step "biome check: no changed files in scope, skipped"
fi

step "anti-slop rules (oxlint)"
bun run lint:slop

step "bun check (root)"
bun run tsc:check

if grep -q '^apps/ui/' <<<"$changed"; then
  step "bun check -b (apps/ui)"
  (cd apps/ui && bun check -b)
fi

# shortcut: narrower than CI's filter (all of src/), because the generators take
# about a minute; a transitive reorder from elsewhere in src/ still fails only in
# CI. Widen to CI's filter if that starts costing first-push reds.
drift "script SDK types" \
  '^(src/tools/|src/be/scripts/|src/scripts-runtime/|src/extensions/|src/types\.ts$|scripts/(bundle-(script|extension)-types\.ts|check-script-types-freshness\.sh)$)' \
  "src/scripts-runtime/types/ src/extensions/contract-types.generated.ts" \
  bash -c 'bun run build:script-types && bun run build:extension-types'
drift "openapi" \
  '^(src/http/|src/types\.ts$|scripts/generate-openapi\.ts$|openapi\.json$|docs-site/content/docs/api-reference/|package\.json$)' \
  "openapi.json docs-site/content/docs/api-reference/ docs-site/public/openapi.d.ts" \
  bun run docs:openapi
drift "pi-skills" \
  '^(plugin/commands/|plugin/pi-skills/|plugin/build-pi-skills\.ts$)' \
  "plugin/pi-skills/" \
  bun run build:pi-skills
drift "seeded skill files and SKILL.md" \
  '^(templates/skills/|src/be/seed-skills/|scripts/(build-seed-skill-files|build-skill-md)\.ts$)' \
  "templates/skills/ src/be/seed-skills/bundled-files.generated.json" \
  bash -c 'bun run build:skill-md && bun run build:seed-skill-files'
drift "extension catalog and manifest schema" \
  '^(templates/extensions/|src/types\.ts$|src/extensions/|scripts/build-extension-(catalog|manifest-schema)\.ts$)' \
  "src/extensions/catalog.generated.json templates/extensions/manifest.schema.json" \
  bash -c 'bun run build:extension-catalog && bun run build:extension-schema'

step "test:root (affected tests)"
PRE_PUSH_TESTS_INCLUDE_WORKTREE=1 bash scripts/pre-push-tests.sh

if [[ "$skip_e2e" == 1 ]]; then
  step "e2e contract: skipped (--skip-e2e)"
else
  step "e2e contract: scoping the diff"
  scope=$(bun scripts/e2e/scope.ts <<<"$changed")
  case "$scope" in
    skip) step "e2e contract: the diff reaches neither the API nor the runner, skipped" ;;
    full)
      step "e2e contract (full suite)"
      bun run e2e
      ;;
    only\ *)
      selected=${scope#only }
      step "e2e contract ($(tr ',' '\n' <<<"$selected" | wc -l | tr -d ' ') scenarios)"
      bun run e2e --only "$selected"
      ;;
    *)
      echo "[check] unexpected scope output: $scope" >&2
      exit 1
      ;;
  esac
fi
