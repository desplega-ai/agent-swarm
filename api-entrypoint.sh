#!/bin/sh
set -e

# Print version banner and run the server
echo "=== Agent Swarm API v$(cat /app/package.json | grep '"version"' | cut -d'"' -f4) ==="
echo "Port: $PORT"
echo "Database: $DATABASE_PATH"
echo "=============================="

exec /usr/local/bin/agent-swarm-api
