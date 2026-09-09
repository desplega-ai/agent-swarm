#!/bin/bash
# Enforce that tests never spawn a child process synchronously.
#
# A synchronous spawn (Bun's sync variant, or node:child_process's sync
# variants) blocks this process's event loop for the child's entire run, so
# a hung child can only be reaped by the test's own timeout, with no
# diagnostic, and the child can still be alive afterward (four incidents in
# one week: entrypoint-codex-oauth-seed, run-bun-tests.test.ts, the
# openapi-response-contract "fail-open" probe). Every test that spawns a
# process must go through runChild() / expectChildOk() from
# src/tests/test-proc.ts instead.
#
# Forbidden patterns, under src/tests/ or any *.test.ts / *.test.tsx under
# src/:
#   - Bun.spawnSync(   (Bun's sync spawn)
#   - spawnSync(       (node:child_process's sync spawn)
#   - execSync(        (node:child_process)
#   - execFileSync(    (node:child_process)

set -euo pipefail

# Files intentionally exempt, each with a one-line reason. Prefer converting
# the site over adding here — every entry is a blind spot this gate cannot
# see reintroduced.
ALLOWLIST=(
  "src/tests/build-pi-skills.test.ts"   # execSync(node:child_process) runs once at describe-block collection time to build plugin/pi-skills; short, deterministic, not a runChild-shaped call site
  "src/tests/package-publish.test.ts"   # execSync(node:child_process) pack/unpack/version probes; already has an explicit setDefaultTimeout(30_000)
)

PATTERN='\bspawnSync\(|\bexecSync\(|\bexecFileSync\('

RAW_MATCHES=$(
  {
    grep -rnE "$PATTERN" --include='*.ts' --include='*.tsx' src/tests/ 2>/dev/null || true
    find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -not -path 'src/tests/*' -print0 \
      | xargs -0 grep -nE "$PATTERN" 2>/dev/null || true
  }
)

VIOLATIONS=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="${line%%:*}"
  allowed=false
  for entry in "${ALLOWLIST[@]}"; do
    if [ "$file" = "$entry" ]; then
      allowed=true
      break
    fi
  done
  if [ "$allowed" = false ]; then
    VIOLATIONS="${VIOLATIONS}${line}"$'\n'
  fi
done <<< "$RAW_MATCHES"

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: synchronous child-process spawn detected in a test file!"
  echo ""
  echo "Bun.spawnSync / spawnSync / execSync / execFileSync block this process's"
  echo "event loop for the child's entire run, so a hung child can only be"
  echo "reaped by the test's own timeout, with no diagnostic."
  echo ""
  echo "Violations:"
  echo -n "$VIOLATIONS"
  echo ""
  echo "Fix: use runChild() / expectChildOk() from src/tests/test-proc.ts and"
  echo "pass CHILD_PROCESS_TEST_BUDGET_MS as the test's timeout argument, or"
  echo "add the file to ALLOWLIST in this script with a one-line reason."
  exit 1
fi

echo "Test spawnSync boundary check passed."
