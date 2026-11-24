#!/bin/bash
# Shared by /k/act and /k/audit. Sourced, not run.
#
# State lives in the client container (no fault takes it down):
#   $S/journal     append-only, one event per line (see README.md for the events)
#   $S/held/<n>/   one empty file per task that simulated agent <n> holds
#   $S/tmp/        scratch files, one set per process

API="${SWARM_API_URL:-http://app:3013}"
KEY="${SWARM_API_KEY:?SWARM_API_KEY is not set}"
S="${KINOKO_STATE_DIR:-/state}"
J="$S/journal"

# The simulated workers. Agent ids must be valid UUIDs.
AGENTS=(
  0a000001-0000-4000-8000-000000000001
  0a000002-0000-4000-8000-000000000002
  0a000003-0000-4000-8000-000000000003
  0a000004-0000-4000-8000-000000000004
)

mkdir -p "$S/held" "$S/tmp"
# Scratch files end in .$$ or .$$.<suffix> (a step that runs beside others).
RESP="$S/tmp/resp.$$"
trap 'rm -f "$S"/tmp/*."$$" "$S"/tmp/*."$$".*' EXIT

# call METHOD PATH AGENT_ID|- [JSON_BODY] [IDEMPOTENCY_KEY]
# Sets CODE (000 when there was no complete answer) and writes the body to $RESP.
# The harness gives up on a command after 10 s of guest time. A step makes at most two
# requests (a poll, then a create), so each request stops at 4 s (CALL_MAX_S).
call() {
  local method=$1 path=$2 agent=$3 body=${4-} idem=${5-}
  local max=${CALL_MAX_S:-4}
  local args=(-sS -m "$max" --connect-timeout 2 -o "$RESP" -w '%{http_code}' -X "$method"
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json')
  [ "$agent" != - ] && args+=(-H "X-Agent-ID: $agent")
  [ -n "$idem" ] && args+=(-H "Idempotency-Key: $idem")
  [ -n "$body" ] && args+=(-d "$body")
  : >"$RESP"
  # `timeout` as well: curl's own limit does not stop a name lookup that hangs.
  CODE=$(timeout -k 1 "$((${max%.*} + 1))" curl "${args[@]}" "$API$path" 2>/dev/null) || CODE=000
  [ -n "$CODE" ] || CODE=000
}

# One journal event. A short line through one write() is atomic under O_APPEND.
jline() { printf '%s\n' "$1" >>"$J"; }

is_terminal() {
  case $1 in
    completed | failed | cancelled | superseded | skipped) return 0 ;;
    *) return 1 ;;
  esac
}

# agent_id N: the id of simulated agent N (1-based). Empty for an unknown N.
agent_id() {
  case $1 in
    '' | *[!0-9]*) return 0 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le "${#AGENTS[@]}" ] && printf '%s' "${AGENTS[$1 - 1]}"
}
