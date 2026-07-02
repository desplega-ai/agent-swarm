#!/usr/bin/env bash
# init-local-redis.sh
#
# Start a local Redis server.
#
# Called automatically from docker-entrypoint.sh when
# SWARM_DEP_REDIS_ENABLED=true.  Can also be run manually.
#
# Idempotent: safe to call multiple times.
# Must run as root; uses `gosu worker` to run redis-server as the worker user.
#
# All settings are env-overridable; the defaults below are just defaults, not policy:
#   LOCAL_REDIS_PORT      — port to listen on         (default: 6379)
#   LOCAL_REDIS_DATA_DIR  — data/log directory         (default: /tmp/redis-data)
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[init-local-redis] ERROR: this helper must run before the worker privilege drop." >&2
  echo "[init-local-redis] Enable SWARM_DEP_REDIS_ENABLED=true or run it from global SETUP_SCRIPT, not per-agent setupScript." >&2
  exit 1
fi

REDIS_PORT="${LOCAL_REDIS_PORT:-6379}"
REDIS_DATA_DIR="${LOCAL_REDIS_DATA_DIR:-/tmp/redis-data}"
REDIS_LOG="${REDIS_DATA_DIR}/redis.log"
REDIS_PID_FILE="${REDIS_DATA_DIR}/redis.pid"

log() { printf '[init-local-redis] %s\n' "$1"; }

# Fail fast if the binary is absent (e.g. image built with SWARM_DEP_REDIS_BUILD=false)
command -v redis-server >/dev/null 2>&1 || {
  echo "[init-local-redis] ERROR: redis-server not found. Rebuild with SWARM_DEP_REDIS_BUILD=true." >&2
  exit 1
}

# Ensure data dir is owned by worker (this script runs as root)
mkdir -p "$REDIS_DATA_DIR"
chown -R worker:worker "$REDIS_DATA_DIR"

# --- 1. Skip if already running ---
if [ -f "$REDIS_PID_FILE" ] && kill -0 "$(cat "$REDIS_PID_FILE")" 2>/dev/null; then
  log "Redis already running on port ${REDIS_PORT} (pid $(cat "$REDIS_PID_FILE"))."
  exit 0
fi

log "Starting Redis on port ${REDIS_PORT} (data dir: ${REDIS_DATA_DIR})..."

gosu worker redis-server \
  --port "$REDIS_PORT" \
  --dir "$REDIS_DATA_DIR" \
  --logfile "$REDIS_LOG" \
  --daemonize yes \
  --pidfile "$REDIS_PID_FILE" \
  --save '' \
  --appendonly no

# --- 2. Health check ---
RETRIES=10
until redis-cli -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "[init-local-redis] ERROR: Redis did not become healthy on port ${REDIS_PORT}." >&2
    exit 1
  fi
  sleep 0.5
done

log "Redis ready at localhost:${REDIS_PORT} (data dir: ${REDIS_DATA_DIR})."
