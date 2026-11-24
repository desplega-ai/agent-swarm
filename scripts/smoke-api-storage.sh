#!/usr/bin/env bash
# Boot the built API image and replace both API containers on their original volumes,
# then copy the SQLite volume into PostgreSQL with `db-copy` from the same image.
set -euo pipefail

export STORAGE_SMOKE_IMAGE=${1:?usage: smoke-api-storage.sh <local-api-image>}
STORAGE_SMOKE_KEY=$(openssl rand -hex 24)
STORAGE_SMOKE_DB_PASSWORD=$(openssl rand -hex 24)
export STORAGE_SMOKE_KEY STORAGE_SMOKE_DB_PASSWORD

fixture="$(dirname "$0")/smoke-api-storage.compose.yml"
project="swarm-storage-$(openssl rand -hex 8)"
compose=(docker compose --env-file /dev/null --file "$fixture" --project-name "$project")
trap '"${compose[@]}" down --volumes' EXIT

api() {
  local service=$1 path=$2 port
  shift 2
  port=$("${compose[@]}" port "$service" 3013)
  curl --fail --silent --show-error --max-time 15 \
    --header "Authorization: Bearer $STORAGE_SMOKE_KEY" "http://$port$path" "$@"
}

create_task() {
  local service=$1 body
  body=$(jq -nc --arg text "$service image recovery" '{task:$text, followUpConfig:{disabled:true}}')
  api "$service" /api/tasks --json "$body" | jq -er '.id | select(type == "string" and length > 0)'
}

check_task() {
  local service=$1 id=$2
  api "$service" "/api/tasks/$id" | jq -e --arg id "$id" --arg text "$service image recovery" \
    '.id == $id and .task == $text' >/dev/null
}

"${compose[@]}" up --detach --wait --wait-timeout 120
sqlite_task=$(create_task sqlite)
postgres_task=$(create_task postgres-api)
"${compose[@]}" exec -T sqlite test -s /app/data/agent-swarm-db.sqlite
pg_count=$("${compose[@]}" exec -T database psql -XAtq -v ON_ERROR_STOP=1 -U swarm -d swarm \
  -v task_id="$postgres_task" <<<"SELECT count(*) FROM agent_tasks WHERE id = :'task_id'")
[[ "$pg_count" == 1 ]] || { echo "The PostgreSQL database did not receive its API task" >&2; exit 1; }

"${compose[@]}" up --detach --no-deps --force-recreate --wait --wait-timeout 120 sqlite postgres-api
check_task sqlite "$sqlite_task"
check_task postgres-api "$postgres_task"
echo "Both replacement API containers served their original task."

# db-copy runs from the same image without booting the API (runbooks/postgres.md,
# "Production cutover"). A booted API never exits, so `timeout` fails a broken dispatch.
db_copy() {
  timeout 300 "${compose[@]}" run --rm --no-deps -T sqlite db-copy "$@"
}
not_booted() {
  ! grep -qE '=== Agent Swarm API|MCP HTTP server running' <<<"$1" ||
    { echo "db-copy booted the API: $1" >&2; exit 1; }
}

help=$(db_copy --help)
grep -qF 'db-copy --from <sqlite file> --to <postgres url>' <<<"$help" ||
  { echo "db-copy --help printed no usage: $help" >&2; exit 1; }
not_booted "$help"

usage_code=0
usage=$(db_copy --from /app/data/agent-swarm-db.sqlite 2>&1) || usage_code=$?
[[ "$usage_code" == 2 ]] || { echo "db-copy without a target exited $usage_code, not 2: $usage" >&2; exit 1; }
grep -qF 'db-copy needs the target' <<<"$usage" || { echo "Unexpected usage error: $usage" >&2; exit 1; }
not_booted "$usage"

"${compose[@]}" stop sqlite
"${compose[@]}" exec -T database psql -XAtq -v ON_ERROR_STOP=1 -U swarm -d swarm \
  -c 'CREATE DATABASE copy_target'
copied=$(db_copy --from /app/data/agent-swarm-db.sqlite \
  --to "postgres://swarm:${STORAGE_SMOKE_DB_PASSWORD}@database:5432/copy_target" \
  --json /app/data/db-copy-report.json)
grep -qF 'every count and checksum equal' <<<"$copied" ||
  { echo "db-copy did not report an equal copy: $copied" >&2; exit 1; }
not_booted "$copied"
copy_count=$("${compose[@]}" exec -T database psql -XAtq -v ON_ERROR_STOP=1 -U swarm -d copy_target \
  -v task_id="$sqlite_task" <<<"SELECT count(*) FROM agent_tasks WHERE id = :'task_id'")
[[ "$copy_count" == 1 ]] || { echo "The copied database does not hold the SQLite task" >&2; exit 1; }
echo "db-copy from the API image copied the SQLite database into PostgreSQL."
