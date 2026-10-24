#!/bin/sh
set -e

# Print version banner and run the server
echo "=== Agent Swarm API v$(cat /app/package.json | grep '"version"' | cut -d'"' -f4) ==="
echo "Port: $PORT"
echo "Database: $DATABASE_PATH"
echo "=============================="

# Native scripts run as a separate sandbox uid when the API is root. Keep the
# database and every file the API creates unreadable to that uid. The chmods
# also fix data volumes created by older images.
umask 077
DB_FILE="${DATABASE_PATH:-/app/data/agent-swarm-db.sqlite}"
DATA_DIR=$(dirname "$DB_FILE")
if [ "$(id -u)" = "0" ]; then
  # Lock only the image's dedicated data directory. A custom DATABASE_PATH can
  # sit in a shared directory (/app, /tmp) that the sandbox uid must traverse.
  if [ "$DATA_DIR" = "/app/data" ] && [ -d "$DATA_DIR" ]; then
    chmod 0700 "$DATA_DIR" || echo "warning: could not chmod 0700 $DATA_DIR"
  fi
  for f in "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm" "$DB_FILE-journal" \
    "$DATA_DIR/.encryption-key" "$DATA_DIR/.page-session-secret"; do
    if [ -f "$f" ]; then
      chmod 0600 "$f" || echo "warning: could not chmod 0600 $f"
    fi
  done
fi

exec /usr/local/bin/agent-swarm-api
