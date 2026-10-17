#!/bin/sh
set -e

# Print version banner and run the server
echo "=== Agent Swarm API v$(cat /app/package.json | grep '"version"' | cut -d'"' -f4) ==="
echo "Port: $PORT"
echo "Database: $DATABASE_PATH"
echo "=============================="

# Native scripts run as a separate sandbox uid when the API is root. Keep the
# database directory and every file the API creates unreadable to that uid.
# The chmod also fixes data volumes created by older images.
umask 077
DATA_DIR=$(dirname "${DATABASE_PATH:-/app/data/agent-swarm-db.sqlite}")
if [ "$(id -u)" = "0" ] && [ -d "$DATA_DIR" ]; then
  chmod 0700 "$DATA_DIR" || echo "warning: could not chmod 0700 $DATA_DIR"
fi

exec /usr/local/bin/agent-swarm-api
