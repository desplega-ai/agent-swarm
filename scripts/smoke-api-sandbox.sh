#!/usr/bin/env bash
# Smoke-test the native script sandbox in a built API image, plus the
# deploy shapes it must stay compatible with.
#
# Usage: bash scripts/smoke-api-sandbox.sh <image> [previous-image]
#
# previous-image defaults to the last published API image. Set
# SKIP_UPGRADE=1 to skip the upgrade and rollback legs (offline runs).
#
# Legs, each a fresh container:
#   default    Docker's default capabilities (the Docker/Dokploy shape):
#              meta.scripts.sandbox "hardened", data dir 700, database 600,
#              the script runs as a non-root uid, cannot read the database or
#              /proc/1/environ, and gets EPERM on spawn. A workflow `script`
#              node runs as the shared sandbox uid and cannot write a /tmp
#              file root created before the upgrade.
#   exec-off   SCRIPT_NATIVE_EXEC_DENY=false (the rollback switch): execDeny
#              "off", level "uid-only", spawn works, the uid drop stays.
#   cap-drop   --cap-drop ALL (k8s `capabilities.drop: [ALL]`): level "none",
#              scripts still run as the API's uid, spawn still gets EPERM.
#   non-root   --user 10001 with a writable data dir: level "none", scripts
#              still run as the API's uid, spawn still gets EPERM.
#   upgrade    a data volume written by previous-image boots on <image> with
#              its data intact and the dir tightened to 700, then boots on
#              previous-image again (image rollback).
set -euo pipefail
# A failed api call inside $(...) must abort the whole run, not just the subshell.
shopt -s inherit_errexit

IMAGE="${1:?usage: smoke-api-sandbox.sh <image> [previous-image]}"
PREV_IMAGE="${2:-ghcr.io/desplega-ai/agent-swarm:latest}"
PREFIX="api-sandbox-smoke-$$"
API_KEY="$(cat /proc/sys/kernel/random/uuid)"
DB_PATH=/app/data/agent-swarm-db.sqlite
DATA_DIR="$(dirname "$DB_PATH")"
NAME=""
BASE_URL=""
AGENT_ID=""
RUNTIME_ID=""

cleanup() {
  if [[ "${KEEP:-0}" == "1" ]]; then return; fi
  docker ps -aq --filter "name=$PREFIX" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume rm -f "$PREFIX-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL [${NAME:-setup}]: $*" >&2
  if [[ -n "$NAME" ]]; then docker logs "$NAME" 2>&1 | tail -40 >&2 || true; fi
  exit 1
}

# start <leg> <image> [docker run args...]: boot a container, set NAME and BASE_URL.
start() {
  local leg="$1" image="$2"
  shift 2
  NAME="$PREFIX-$leg"
  docker run -d --name "$NAME" -p 127.0.0.1::3013 \
    -e AGENT_SWARM_API_KEY="$API_KEY" \
    -e DESPLEGA_TELEMETRY_ENV=test \
    -e ANONYMIZED_TELEMETRY=false \
    "$@" "$image" >/dev/null
  BASE_URL="http://$(docker port "$NAME" 3013/tcp | head -1)"
  AGENT_ID="$(cat /proc/sys/kernel/random/uuid)"
  RUNTIME_ID="$(cat /proc/sys/kernel/random/uuid)"
  echo "== $leg ($image $*)"
}

stop() {
  docker rm -f "$NAME" >/dev/null
}

# wait_health: wait for /health, then echo meta.scripts once the probe has run
# ("{}" for an image without it).
wait_health() {
  local body=""
  for _ in $(seq 1 120); do
    body="$(curl -fsS "$BASE_URL/health" 2>/dev/null || true)"
    if [[ -n "$body" ]] && ! printf '%s' "$body" | jq -e '.meta.scripts.sandbox == "pending"' >/dev/null; then
      printf '%s' "$body" | jq -c '.meta.scripts // {}'
      return
    fi
    sleep 0.5
  done
  fail "/health not ready: ${body:-<none>}"
}

# expect_health <sandbox> <execDeny>
expect_health() {
  local scripts
  scripts="$(wait_health)"
  echo "meta.scripts: $scripts"
  printf '%s' "$scripts" | jq -e --arg s "$1" --arg e "$2" \
    '.sandbox == $s and .execDeny == $e and .scope == "native-executor"' >/dev/null ||
    fail "/health meta.scripts is $scripts, expected sandbox=$1 execDeny=$2"
}

api() {
  local method="$1" path="$2" body="${3:-}" out
  if ! out="$(printf '%s' "$body" | curl -sS --fail-with-body -X "$method" "$BASE_URL$path" \
    -H "Authorization: Bearer $API_KEY" \
    -H "X-Agent-ID: $AGENT_ID" \
    -H "X-Runtime-Instance-ID: $RUNTIME_ID" \
    -H "Content-Type: application/json" \
    ${body:+-d @-})"; then
    fail "$method $path: $(printf '%s' "$out" | head -c 1000)"
  fi
  printf '%s' "$out"
}

# Multi-runtime mode (the default) needs a runtime identity on register and run.
register_agent() {
  api POST /api/agents "$(jq -n --arg rid "$RUNTIME_ID" \
    '{name: "Sandbox Smoke Agent", isLead: false, runtimeInstanceId: $rid}')" >/dev/null
}

PROBE_SOURCE=$(cat <<EOF
export default async () => {
  const canRead = async (path: string) => {
    try {
      await Bun.file(path).bytes();
      return true;
    } catch {
      return false;
    }
  };
  let spawnExit: string;
  try {
    spawnExit = String(await Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" }).exited);
  } catch (error) {
    spawnExit = String((error as { code?: string }).code ?? error);
  }
  return {
    uid: process.getuid(),
    canReadDb: await canRead("$DB_PATH"),
    canReadInitEnviron: await canRead("/proc/1/environ"),
    spawnExit,
  };
};
EOF
)

# probe: run the inline script, echo its result object.
probe() {
  local response result
  register_agent
  response="$(api POST /api/scripts/run "$(jq -n --arg source "$PROBE_SOURCE" \
    '{source: $source, args: {}, intent: "api image sandbox smoke"}')")"
  result="$(printf '%s' "$response" | jq -c '[.. | objects | select(has("canReadDb"))][0] // empty')"
  [[ -n "$result" ]] || fail "no sandbox result in response: $(printf '%s' "$response" | head -c 1000)"
  echo "script result: $result" >&2
  printf '%s' "$result"
}

# expect <json> <jq filter> <message>
expect() {
  printf '%s' "$1" | jq -e "$2" >/dev/null || fail "$3: $1"
}

# workflow_probe: run a one-node workflow `script` node, echo its stdout.
workflow_probe() {
  local script="$1" created run_id run=""
  created="$(api POST /api/workflows "$(jq -n --arg script "$script" \
    --arg name "sandbox-smoke-$(cat /proc/sys/kernel/random/uuid)" '{
    name: $name,
    definition: {nodes: [{id: "probe", type: "script", config: {runtime: "bash", script: $script}}]}
  }')")"
  run_id="$(api POST "/api/workflows/$(printf '%s' "$created" | jq -r '.id // .workflow.id')/trigger" '{}' |
    jq -r .runId)"
  for _ in $(seq 1 60); do
    run="$(api GET "/api/workflow-runs/$run_id")"
    if printf '%s' "$run" | jq -e '.run.status | IN("completed", "failed")' >/dev/null; then break; fi
    sleep 0.5
  done
  printf '%s' "$run" | jq -e '.run.status == "completed"' >/dev/null ||
    fail "workflow run did not complete: $(printf '%s' "$run" | head -c 1000)"
  printf '%s' "$run" | jq -r '.steps[] | select(.nodeId == "probe") | .output.stdout'
}

# --- default: the Docker/Dokploy shape ---------------------------------------
start default "$IMAGE"
expect_health hardened best-effort
# Positive controls: both files exist and root can read them.
docker exec "$NAME" test -r "$DB_PATH" || fail "control: $DB_PATH missing in the container"
docker exec "$NAME" test -r /proc/1/environ || fail "control: root cannot read /proc/1/environ"
MODE="$(docker exec "$NAME" stat -c %a "$DATA_DIR")"
[[ "$MODE" == "700" ]] || fail "data dir mode is $MODE, expected 700"
MODE="$(docker exec "$NAME" stat -c %a "$DB_PATH")"
[[ "$MODE" == "600" ]] || fail "database mode is $MODE, expected 600 (umask 077)"
R="$(probe)"
expect "$R" '.uid != 0' "script ran as uid 0"
expect "$R" '.canReadDb == false' "script can read the database"
expect "$R" '.canReadInitEnviron == false' "script can read /proc/1/environ"
expect "$R" '.spawnExit == "EPERM"' "spawn was not denied"
# Workflow script nodes: the shared sandbox uid owns its own fixed /tmp files
# across runs, but a /tmp file root wrote before the upgrade is read-only to it.
docker exec "$NAME" sh -c 'echo legacy > /tmp/sandbox-smoke-legacy'
OUT="$(workflow_probe 'echo "uid=$(id -u)"
f=/tmp/sandbox-smoke-fixed; echo run >> $f && echo "fixed=ok"
echo x >> /tmp/sandbox-smoke-legacy 2>/dev/null && echo "legacy=ok" || echo "legacy=denied"')"
echo "workflow node: $(printf '%s' "$OUT" | tr '\n' ' ')"
grep -qx 'uid=0' <<<"$OUT" && fail "workflow script node ran as uid 0"
grep -qx 'fixed=ok' <<<"$OUT" || fail "workflow script node cannot write its own /tmp file: $OUT"
grep -qx 'legacy=denied' <<<"$OUT" || fail "workflow script node wrote a root-owned /tmp file: $OUT"
OUT="$(workflow_probe 'echo run >> /tmp/sandbox-smoke-fixed && echo "fixed=$(wc -l < /tmp/sandbox-smoke-fixed)"')"
grep -qx 'fixed=2' <<<"$OUT" || fail "a fixed /tmp path did not survive across workflow runs: $OUT"
stop

# --- exec-off: the operator rollback switch ----------------------------------
start exec-off "$IMAGE" -e SCRIPT_NATIVE_EXEC_DENY=false
expect_health uid-only off
R="$(probe)"
expect "$R" '.uid != 0' "script ran as uid 0"
expect "$R" '.canReadDb == false' "script can read the database"
expect "$R" '.spawnExit == "0"' "spawn still denied with SCRIPT_NATIVE_EXEC_DENY=false"
stop

# --- cap-drop: k8s capabilities.drop [ALL] -----------------------------------
start cap-drop "$IMAGE" --cap-drop ALL
expect_health none best-effort
R="$(probe)"
expect "$R" '.uid == 0' "script did not run as the API's uid"
expect "$R" '.spawnExit == "EPERM"' "spawn was not denied under --cap-drop ALL"
stop

# --- non-root: the API itself runs as a plain uid ----------------------------
start non-root "$IMAGE" --user 10001:10001 --tmpfs "$DATA_DIR:uid=10001,gid=10001,mode=0755"
expect_health none best-effort
R="$(probe)"
expect "$R" '.uid == 10001' "script did not run as the API's uid"
expect "$R" '.spawnExit == "EPERM"' "spawn was not denied as a non-root API"
stop

# --- upgrade + image rollback on one data volume ------------------------------
if [[ "${SKIP_UPGRADE:-0}" == "1" ]]; then
  echo "SKIP_UPGRADE=1: upgrade leg skipped"
else
  docker pull -q "$PREV_IMAGE" >/dev/null || fail "cannot pull $PREV_IMAGE (set SKIP_UPGRADE=1 to skip)"
  VOLUME="$PREFIX-data"
  docker volume create "$VOLUME" >/dev/null

  start upgrade-old "$PREV_IMAGE" -v "$VOLUME:$DATA_DIR"
  wait_health >/dev/null
  register_agent
  OLD_AGENT="$AGENT_ID"
  echo "previous image: dir $(docker exec "$NAME" stat -c '%a %u:%g' "$DATA_DIR"), db $(docker exec "$NAME" stat -c '%a %u:%g' "$DB_PATH")"
  stop

  start upgrade-new "$IMAGE" -v "$VOLUME:$DATA_DIR"
  expect_health hardened best-effort
  api GET "/api/agents/$OLD_AGENT" >/dev/null
  STAT="$(docker exec "$NAME" stat -c '%a %u:%g' "$DATA_DIR")"
  [[ "$STAT" == "700 0:0" ]] || fail "upgraded data dir is '$STAT', expected '700 0:0'"
  STAT="$(docker exec "$NAME" stat -c '%u:%g' "$DB_PATH")"
  [[ "$STAT" == "0:0" ]] || fail "upgraded database owner is $STAT, expected 0:0"
  R="$(probe)"
  expect "$R" '.uid != 0 and .canReadDb == false' "upgraded volume is readable by the script"
  stop

  start upgrade-rollback "$PREV_IMAGE" -v "$VOLUME:$DATA_DIR"
  wait_health >/dev/null
  AGENT_ID="$OLD_AGENT"
  api GET "/api/agents/$OLD_AGENT" >/dev/null
  stop
fi

echo "API sandbox smoke passed"
