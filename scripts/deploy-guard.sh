#!/bin/bash
# Main-tip guard for .github/workflows/docker-and-deploy.yml (job
# promote-main-tags, step "guard"; job detect-version-change, step
# "supersede", where is_tip=false skips the run's builds).
#
# Writes is_tip=true|false to $GITHUB_OUTPUT. is_tip=true means "this run
# moves :latest and :slim". Prod runs :prod, which only deploy.yml moves.
#
# Skip only when a newer main commit touches on.push.paths, so it starts its
# own run and promotion. A newer docs-only commit starts no run; skipping for
# it would leave :latest on an older build.
#
# Inputs (env): GITHUB_SHA, GITHUB_OUTPUT, and optionally WORKFLOW_FILE.
# Regression test: src/tests/deploy-guard.test.ts.

set -euo pipefail

workflow_file="${WORKFLOW_FILE:-.github/workflows/docker-and-deploy.yml}"

git fetch --no-tags origin main:refs/remotes/origin/main
main_tip="$(git rev-parse origin/main)"

echo "Running commit: ${GITHUB_SHA}"
echo "Current origin/main: ${main_tip}"

if [ "${GITHUB_SHA}" = "${main_tip}" ]; then
  echo "is_tip=true" >> "$GITHUB_OUTPUT"
  echo "::notice::Running commit is still the main tip; proceeding with tag promotion"
  exit 0
fi

# The trigger paths live only in on.push.paths of the workflow; read them from there.
mapfile -t pathspecs < <(yq -r '.on.push.paths[] | ":(glob)" + .' "${workflow_file}")
if [ "${#pathspecs[@]}" -eq 0 ]; then
  echo "::error::Could not read on.push.paths from ${workflow_file}"
  exit 1
fi

changed="$(git diff --name-only "${GITHUB_SHA}" "${main_tip}" -- "${pathspecs[@]}")"
if [ -z "${changed}" ]; then
  echo "is_tip=true" >> "$GITHUB_OUTPUT"
  echo "::notice::Newer main commits up to ${main_tip} touch no trigger paths and start no run; proceeding with tag promotion"
else
  echo "is_tip=false" >> "$GITHUB_OUTPUT"
  echo "Trigger-path files changed since ${GITHUB_SHA}:"
  sed -n '1,20p' <<<"${changed}"
  echo "::notice::Skipping tag promotion because newer main commits up to ${main_tip} touch trigger paths and start their own run"
fi
