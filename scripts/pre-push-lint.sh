#!/usr/bin/env bash
# Pre-push lint (wired from prek.toml): `biome` or `oxlint` on the files this
# branch changed since its merge-base with origin/main, inside the root lint
# scope (package.json `lint` / `lint:slop`). Runs the whole scope instead when
# PRE_PUSH_FULL=1, when origin/main is missing, or when a linter config, the
# lockfile or package.json changed. CI runs the whole scope on every PR.
#
#   bash scripts/pre-push-lint.sh biome|oxlint
set -euo pipefail

tool=${1:?usage: pre-push-lint.sh biome|oxlint}
LINT_SCOPE='^(src|apps/evals|packages/ui-e2e|packages/model-routing|packages/model-catalog)/'
CONFIG_PATHS='^(biome\.json|oxlint\.config\.ts|tools/oxlint/|package\.json$|bun\.lock)'

full() {
  case "$tool" in
    biome) exec bun run lint ;;
    oxlint) exec bun run lint:slop ;;
    *) echo "unknown linter: $tool" >&2 && exit 2 ;;
  esac
}

[[ "${PRE_PUSH_FULL:-}" == 1 ]] && full
base=$(git merge-base origin/main HEAD 2>/dev/null) || full
git diff --name-only "$base" HEAD | grep -Eq "$CONFIG_PATHS" && full

files=$(git diff --name-only --diff-filter=d "$base" HEAD | grep -E "$LINT_SCOPE" || true)
if [[ "$tool" == oxlint ]]; then
  files=$(grep -E '\.[cm]?[jt]sx?$' <<<"$files" || true)
fi
if [[ -z "$files" ]]; then
  echo "[pre-push-lint] $tool: no changed files in scope"
  exit 0
fi
echo "[pre-push-lint] $tool: $(wc -l <<<"$files" | tr -d ' ') changed file(s) (PRE_PUSH_FULL=1 lints the whole scope)"
case "$tool" in
  biome) tr '\n' '\0' <<<"$files" | xargs -0 bunx biome check --no-errors-on-unmatched --files-ignore-unknown=true ;;
  oxlint) tr '\n' '\0' <<<"$files" | xargs -0 bun --bun oxlint --no-error-on-unmatched-pattern ;;
  *) echo "unknown linter: $tool" >&2 && exit 2 ;;
esac
