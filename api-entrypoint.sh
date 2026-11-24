#!/bin/sh
set -e

# `db-copy` copies a SQLite database into an empty Postgres database without
# booting the API (runbooks/postgres.md, "Production cutover"). No banner: the
# copy output stays clean.
if [ "$1" = "db-copy" ]; then
  exec /usr/local/bin/agent-swarm-api "$@"
fi

# Print version banner and run the server
echo "=== Agent Swarm API v$(cat /app/package.json | grep '"version"' | cut -d'"' -f4) ==="
echo "Port: $PORT"
echo "Database: $DATABASE_PATH"
echo "=============================="

exec /usr/local/bin/agent-swarm-api "$@"
