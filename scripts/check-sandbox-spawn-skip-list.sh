#!/bin/bash
# Keep scripts/pre-push-tests.sh's printed skip-list in sync with reality.
#
# The real gate is SKIP_SANDBOX_SPAWN_TESTS (src/tests/sandbox-spawn-test-helpers.ts):
# a test file only actually skips when it imports that helper and gates a test on
# it. The list pre-push-tests.sh prints when the sandbox spawn probe trips is
# purely cosmetic — nothing enforces that it matches the importer set, so it can
# silently drift (a file starts importing the helper without being added to the
# list, or vice versa). This check makes that drift a hard failure instead of a
# repeat of the gap fixed alongside this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMPORTERS=$(grep -rl "sandbox-spawn-test-helpers" src/tests/ | sort)
PRINTED=$(grep -oE 'src/tests/[A-Za-z0-9._-]+\.test\.ts' scripts/pre-push-tests.sh | sort -u)

if [ "$IMPORTERS" != "$PRINTED" ]; then
  echo "ERROR: scripts/pre-push-tests.sh's printed skip-list has drifted from the" >&2
  echo "SKIP_SANDBOX_SPAWN_TESTS importer set." >&2
  echo "" >&2
  echo "Imports the helper but missing from the printed list:" >&2
  comm -23 <(echo "$IMPORTERS") <(echo "$PRINTED") | sed 's/^/  + /' >&2
  echo "" >&2
  echo "Printed in the list but does not import the helper:" >&2
  comm -13 <(echo "$IMPORTERS") <(echo "$PRINTED") | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Fix: update the printed list in scripts/pre-push-tests.sh, or gate the" >&2
  echo "missing file's spawn-dependent tests on SKIP_SANDBOX_SPAWN_TESTS the same" >&2
  echo "way its siblings do (see src/tests/scripts-runtime.test.ts)." >&2
  exit 1
fi

echo "Sandbox spawn skip-list check passed ($(echo "$IMPORTERS" | wc -l | tr -d ' ') files)."
