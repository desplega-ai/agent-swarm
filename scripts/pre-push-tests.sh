#!/usr/bin/env bash
# Pre-push unit tests (wired from prek.toml).
#
# Runs the root suite under `bun test --parallel=4`, scoped with `--changed` to
# the test files whose import graph touches what this branch changed since its
# merge-base with origin/main. Falls back to the FULL suite when:
#   - origin/main is not available (no merge-base to diff against), or
#   - the branch touches an input that reaches every test outside the import
#     graph: migrations (the preload template), templates/ (seeders), bunfig.toml
#     ([test] config), package.json or bun.lock (dependency graph).
#
# `--changed` must compare against the merge-base, not origin/main itself, or
# every upstream commit counts as a change. See LOCAL_TESTING.md.
set -euo pipefail

FULL_RUN_PATHS='^(src/be/migrations/|templates/|bunfig\.toml$|package\.json$|bun\.lock)'

if ! base=$(git merge-base origin/main HEAD 2>/dev/null); then
  echo "[pre-push-tests] origin/main not found; running the full suite"
  exec bun run test:root -- --parallel=4
fi

if git diff --name-only "$base" HEAD | grep -Eq "$FULL_RUN_PATHS"; then
  echo "[pre-push-tests] migrations/templates/bunfig/deps changed; running the full suite"
  exec bun run test:root -- --parallel=4
fi

echo "[pre-push-tests] running tests affected since $base"
exec bun run test:root -- --parallel=4 --changed="$base"
