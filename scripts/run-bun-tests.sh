#!/usr/bin/env bash

set -o pipefail

test_log="$(mktemp "${RUNNER_TEMP:-/tmp}/bun-test.log.XXXXXX")"
test_db_template=""
template_log=""
shard_logs=()
cleanup() {
  rm -f "$test_log"
  if [[ -n "$test_db_template" ]]; then
    rm -f "$test_db_template"
  fi
  if [[ -n "$template_log" ]]; then
    rm -f "$template_log"
  fi
  for shard_log in "${shard_logs[@]}"; do
    rm -f "$shard_log"
  done
}
trap cleanup EXIT

# Preserve the real Bun executable for wrapper tests that intentionally put a
# fake `bun` first on PATH. Bun's test workers do not retain npm_execpath.
bun_runtime="${BUN_TEST_RUNTIME:-${npm_execpath:-$(command -v bun)}}"
export BUN_TEST_RUNTIME="$bun_runtime"

if [[ -z "${AGENT_SWARM_TEST_DB_TEMPLATE:-}" ]]; then
  test_db_template="$(mktemp "${RUNNER_TEMP:-/tmp}/bun-test-db.sqlite.XXXXXX")"
  template_log="$(mktemp "${RUNNER_TEMP:-/tmp}/bun-test-db.log.XXXXXX")"
  if ! "$bun_runtime" run src/tests/build-db-template.ts "$test_db_template" \
    >"$template_log" 2>&1; then
    cat "$template_log" >&2
    echo "Failed to prepare the shared test database template" >&2
    exit 1
  fi
  export AGENT_SWARM_TEST_DB_TEMPLATE="$test_db_template"
fi

parallelism="${BUN_TEST_PARALLELISM:-4}"
if [[ ! "$parallelism" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_TEST_PARALLELISM must be a positive integer, got: $parallelism" >&2
  exit 2
fi

set +e
if [[ "$#" -gt 0 || "$parallelism" -eq 1 ]]; then
  bun test "$@" 2>&1 | tee "$test_log"
  test_status="${PIPESTATUS[0]}"
else
  shard_pids=()
  for ((shard_index = 1; shard_index <= parallelism; shard_index++)); do
    shard_log="$(mktemp "${RUNNER_TEMP:-/tmp}/bun-test-shard.log.XXXXXX")"
    shard_logs+=("$shard_log")
    bun test --shard="$shard_index/$parallelism" 2>&1 | tee "$shard_log" &
    shard_pids+=("$!")
  done

  test_status=0
  for shard_pid in "${shard_pids[@]}"; do
    wait "$shard_pid"
    shard_status="$?"
    if [[ "$test_status" -eq 0 && "$shard_status" -ne 0 ]]; then
      test_status="$shard_status"
    fi
  done

  for shard_log in "${shard_logs[@]}"; do
    cat "$shard_log" >>"$test_log"
  done
fi
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
