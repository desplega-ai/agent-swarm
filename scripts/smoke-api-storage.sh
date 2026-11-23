#!/usr/bin/env bash
# Boot the built API image and replace both API containers on their original volumes.
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
