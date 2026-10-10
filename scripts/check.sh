#!/usr/bin/env bash
# `bun run check`: one local check loop for agents and humans, run before a push.
#
#   1. bun install --frozen-lockfile
#   2. Biome (read-only, like CI's `bun run lint`) on changed files it lints in CI
#   3. anti-slop Oxlint rules (`bun run lint:slop`, whole scope, about 5 s)
#   4. tsgo on the root project, plus apps/ui when it changed
#   5. test:root on the tests affected by the change (scripts/pre-push-tests.sh
#      scoping, including its full-suite fallbacks)
#
# "Changed" means committed since the merge-base with origin/main, plus
# uncommitted and untracked edits. Stops at the first failing step.
#
# Secrets scanning stays with the prek pre-push hooks; this script does not run
# it. CI stays authoritative: tsc 5, Biome over the whole lint scope, the
# sharded suite, and the drift/boundary checks in runbooks/ci.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Directories CI runs Biome on: root `bun run lint` plus apps/ui's own lint.
BIOME_SCOPE='^(src/|apps/evals/|apps/ui/|packages/ui-e2e/|packages/model-routing/)'

step() { printf '\n[check] %s\n' "$1"; }

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

step "tsgo --noEmit (root)"
bun run tsc:check

if grep -q '^apps/ui/' <<<"$changed"; then
  step "tsgo -b (apps/ui)"
  (cd apps/ui && bunx tsgo -b)
fi

step "test:root (affected tests)"
PRE_PUSH_TESTS_INCLUDE_WORKTREE=1 bash scripts/pre-push-tests.sh
