#!/usr/bin/env bash

set -o pipefail

test_log="$(mktemp "${RUNNER_TEMP:-/tmp}/bun-test.log.XXXXXX")"
trap 'rm -f "$test_log"' EXIT

set +e
bun test "$@" 2>&1 | tee "$test_log"
test_status="${PIPESTATUS[0]}"
set -e

if [[ "$test_status" -ne 0 ]]; then
  error_count="$(
    sed -nE 's/^[[:space:]]*([0-9]+) errors?[[:space:]]*$/\1/p' "$test_log" | tail -n 1
  )"
  fail_count="$(
    sed -nE 's/^[[:space:]]*([0-9]+) fails?[[:space:]]*$/\1/p' "$test_log" | tail -n 1
  )"

  if [[ -n "$error_count" && "$error_count" -gt 0 ]]; then
    message="Bun reported ${error_count} unhandled error(s) outside normal test failures (${fail_count:-unknown} fail). Search this step for '# Unhandled error between tests'."
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
      echo "::error title=Bun unhandled test error::${message}"
    fi

    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      {
        echo "### Bun test runner failure"
        echo
        echo "${message}"
        echo
        echo '```text'
        awk '
          /# Unhandled error between tests/ { remaining = 17 }
          remaining > 0 && shown < 80 {
            print
            remaining--
            shown++
          }
        ' "$test_log"
        echo
        sed -nE '/^[[:space:]]*[0-9]+ (pass|skip|fail|error)s?[[:space:]]*$/p' "$test_log"
        echo '```'
      } >>"$GITHUB_STEP_SUMMARY"
    fi
  fi
fi

exit "$test_status"
