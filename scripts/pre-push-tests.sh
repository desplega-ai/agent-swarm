#!/usr/bin/env bash
# Pre-push unit tests (wired from prek.toml).
#
# Runs, under `bun test --parallel=4`, only the test files nearest to what this
# branch changed since its merge-base with origin/main, as picked by
# scripts/pre-push-affected-tests.ts (changed tests, then importers outward up to
# a per-file budget, then tests that name a non-code file). A push with no
# affected test runs none. CI stays authoritative: pull requests run the whole
# `bun test --changed` import graph, and the merge queue runs the full suite.
#
# Runs the FULL suite instead when:
#   - PRE_PUSH_FULL=1 is set (the local escape hatch), or
#   - origin/main is not available (no merge-base to diff against), or
#   - the branch touches an input every test loads outside the import graph:
#     the preload and its preload-only helpers, bunfig.toml ([test] config), or
#     tsconfig.json (path aliases).
#
# Keep the explicit 10s timeout in parity with merge-gate.yml and ci.yml;
# bunfig.toml intentionally sets no global test timeout.
#
# One run at a time per user on this machine: the script holds a lock on
# /tmp/agent-swarm-pre-push-tests-<uid>.lock (flock, or lockf on macOS) for
# its whole run, and every other worktree waits. Concurrent runs from parallel
# agents oversubscribe the CPU, and 1 s tests then exceed the 10 s timeout. With
# no lock tool, the script runs unlocked.
set -euo pipefail

# git exports GIT_DIR (and friends) to a hook when the push runs from a linked
# worktree. Every git child a test spawns would inherit it and act on the
# pushing repo instead of its temp fixture. Hooks run at the worktree root, so
# git below still finds this repo by discovery.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)

lock_file="/tmp/agent-swarm-pre-push-tests-$(id -u).lock"
if [[ "${PRE_PUSH_TESTS_LOCKED:-}" != 1 ]]; then
  try_lock=()
  hold_lock=()
  if command -v flock >/dev/null 2>&1; then
    try_lock=(flock -n "$lock_file" true)
    hold_lock=(flock "$lock_file")
  elif command -v lockf >/dev/null 2>&1; then
    try_lock=(lockf -k -t 0 "$lock_file" true)
    hold_lock=(lockf -k "$lock_file")
  fi
  if [[ "${#hold_lock[@]}" -gt 0 ]]; then
    if ! "${try_lock[@]}" 2>/dev/null; then
      echo "[pre-push-tests] waiting for the test run of another worktree ($(cat "$lock_file.owner" 2>/dev/null || echo "owner unknown"))"
    fi
    PRE_PUSH_TESTS_LOCKED=1 exec "${hold_lock[@]}" bash "${BASH_SOURCE[0]}" "$@"
  fi
fi
if [[ "${PRE_PUSH_TESTS_LOCKED:-}" == 1 ]]; then
  echo "pid $$ in $PWD since $(date +%H:%M:%S)" >"$lock_file.owner" 2>/dev/null || true
fi

FULL_RUN_PATHS='^(src/tests/(preload|hang-watchdog|hang-watchdog-worker|fixtures/child-write-guard|fixtures/child-write-guard-preload|fixtures/profile-write-guard)\.ts$|bunfig\.toml$|tsconfig\.json$)'

# The push compares commits only. `bun run check:local` (scripts/check.sh) sets
# PRE_PUSH_TESTS_INCLUDE_WORKTREE=1 so uncommitted edits count as changes too.
diff_to=HEAD
if [[ "${PRE_PUSH_TESTS_INCLUDE_WORKTREE:-}" == 1 ]]; then
  diff_to=
fi

run_full_suite() {
  # Mirror merge-gate's shard boundaries so local load matches CI.
  bun run test:root -- --timeout 10000 --parallel=4 --shard=1/4
  bun run test:root -- --timeout 10000 --parallel=4 --shard=2/4
  bun run test:root -- --timeout 10000 --parallel=4 --shard=3/4
  exec bun run test:root -- --timeout 10000 --parallel=4 --shard=4/4
}

probe_file=$(mktemp)
trap 'rm -f "$probe_file"' EXIT
# An immediate exit can finish before Bun's delayed worker-thread startup hits
# RLIMIT_NPROC, so keep the otherwise trivial file alive past that point.
printf 'await Bun.sleep(1500);\n' >"$probe_file"
probe_status=0
{ bash -c 'ulimit -v 4194304 2>/dev/null || true; ulimit -t 60 2>/dev/null || true; ulimit -u 512 2>/dev/null || true; ulimit -f 65536 2>/dev/null || true; ulimit -n 64 2>/dev/null || true; exec env -i PATH="${PATH:-/usr/bin:/bin}" HOME=/tmp LANG=C.UTF-8 LC_ALL=C.UTF-8 TMPDIR=/tmp bun --no-orphans run "$1"' _ "$probe_file" >/dev/null 2>&1; } 2>/dev/null || probe_status=$?
rm -f "$probe_file"
trap - EXIT

if [[ "$probe_status" -eq 134 ]]; then
  export SWARM_SKIP_SANDBOX_SPAWN_TESTS=1
  echo "[pre-push-tests] sandbox spawn probe exited 134; skipping spawn-dependent tests in:"
  printf '  %s\n' \
    src/tests/app-action-run-tool.test.ts \
    src/tests/app-row-tools.test.ts \
    src/tests/apps-rbac.test.ts \
    src/tests/apps-spike2.test.ts \
    src/tests/audit-agent-person.test.ts \
    src/tests/apps-sync-engine.test.ts \
    src/tests/connection-embedded-auth.test.ts \
    src/tests/heartbeat-jev-gate-credentials.test.ts \
    src/tests/sandboxed-process.test.ts \
    src/tests/schedule-target-type.test.ts \
    src/tests/script-api-credential.test.ts \
    src/tests/script-connections-sql.test.ts \
    src/tests/script-connections.test.ts \
    src/tests/script-executor-conformance.test.ts \
    src/tests/script-native-sandbox-identity.test.ts \
    src/tests/script-native-startup.test.ts \
    src/tests/script-native-unawaited-drain.test.ts \
    src/tests/script-workflows-runtime-e2e.test.ts \
    src/tests/secret-canary-sweep.test.ts \
    src/tests/scripts-external-api.test.ts \
    src/tests/scripts-fs.test.ts \
    src/tests/scripts-http.test.ts \
    src/tests/scripts-mcp-e2e.test.ts \
    src/tests/scripts-retention.test.ts \
    src/tests/scripts-runtime-identity.test.ts \
    src/tests/scripts-runtime-secret-egress.test.ts \
    src/tests/scripts-runtime.test.ts \
    src/tests/slack-read-boundaries.test.ts \
    src/tests/workflow-e2e.test.ts \
    src/tests/workflow-engine-v2.test.ts \
    src/tests/workflow-executors.test.ts \
    src/tests/workflow-foreach-bodies.test.ts \
    src/tests/workflow-swarm-script.test.ts
elif [[ "$probe_status" -ne 0 ]]; then
  echo "[pre-push-tests] sandbox spawn probe failed unexpectedly with exit $probe_status" >&2
  exit "$probe_status"
fi

if [[ "${PRE_PUSH_FULL:-}" == 1 ]]; then
  echo "[pre-push-tests] PRE_PUSH_FULL=1; running the full suite"
  run_full_suite
fi

if ! base=$(git merge-base origin/main HEAD 2>/dev/null); then
  echo "[pre-push-tests] origin/main not found; running the full suite"
  run_full_suite
fi

changed=$(
  {
    git diff --name-only "$base" ${diff_to:+"$diff_to"}
    [[ -n "$diff_to" ]] || git ls-files --others --exclude-standard
  } | sort -u
)

if grep -Eq "$FULL_RUN_PATHS" <<<"$changed"; then
  echo "[pre-push-tests] the preload, bunfig.toml or tsconfig.json changed; running the full suite"
  run_full_suite
fi

# Command substitution, not process substitution: a selector crash must fail the hook.
selection=$(bun scripts/pre-push-affected-tests.ts <<<"$changed")
mapfile -t tests <<<"$selection"
[[ -n "$selection" ]] || tests=()
if [[ "${#tests[@]}" -eq 0 ]]; then
  echo "[pre-push-tests] no affected test files since $base; CI runs the rest (PRE_PUSH_FULL=1 runs the full suite)"
  exit 0
fi
echo "[pre-push-tests] running ${#tests[@]} affected test file(s) since $base (PRE_PUSH_FULL=1 runs the full suite)"
exec bun run test:root -- --timeout 10000 --parallel=4 "${tests[@]}"
