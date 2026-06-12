#!/usr/bin/env bash
# init-local-nats.sh
#
# Start a local NATS server with JetStream enabled.
#
# Called automatically from docker-entrypoint.sh when
# SWARM_DEP_NATS_ENABLED=true.  Can also be run manually.
#
# Idempotent: safe to call multiple times.
# Must run as root; uses `gosu worker` to run nats-server as the worker user.
#
# All settings are env-overridable; the defaults below are just defaults, not policy:
#   LOCAL_NATS_PORT          — client port               (default: 4222)
#   LOCAL_NATS_MONITOR_PORT  — HTTP monitoring port       (default: 8222)
#   LOCAL_NATS_DATA_DIR      — JetStream store directory  (default: /tmp/nats-data)
set -euo pipefail

NATS_PORT="${LOCAL_NATS_PORT:-4222}"
NATS_MONITOR_PORT="${LOCAL_NATS_MONITOR_PORT:-8222}"
NATS_DATA_DIR="${LOCAL_NATS_DATA_DIR:-/tmp/nats-data}"
NATS_PID_FILE="${NATS_DATA_DIR}/nats-server.pid"
NATS_LOG_FILE="${NATS_DATA_DIR}/nats-server.log"

log() { printf '[init-local-nats] %s\n' "$1"; }

# Fail fast if the binary is absent (e.g. image built with SWARM_DEP_NATS_BUILD=false)
command -v nats-server >/dev/null 2>&1 || {
  echo "[init-local-nats] ERROR: nats-server not found. Rebuild with SWARM_DEP_NATS_BUILD=true." >&2
  exit 1
}

# Ensure data dir is owned by worker (this script runs as root)
mkdir -p "$NATS_DATA_DIR"
chown -R worker:worker "$NATS_DATA_DIR"

# --- 1. Skip if already running ---
if [ -f "$NATS_PID_FILE" ] && kill -0 "$(cat "$NATS_PID_FILE")" 2>/dev/null; then
  log "NATS already running on port ${NATS_PORT} (pid $(cat "$NATS_PID_FILE"))."
  exit 0
fi

log "Starting NATS (JetStream) on port ${NATS_PORT}, monitor port ${NATS_MONITOR_PORT} (store: ${NATS_DATA_DIR})..."

# nats-server has no --daemonize flag; use nohup + background + pidfile.
# gosu drops to worker for the actual process.
nohup gosu worker nats-server \
  -js \
  -sd "$NATS_DATA_DIR" \
  -a 127.0.0.1 \
  -p "$NATS_PORT" \
  -m "$NATS_MONITOR_PORT" \
  -l "$NATS_LOG_FILE" \
  >> "$NATS_LOG_FILE" 2>&1 &
echo $! > "$NATS_PID_FILE"
chown worker:worker "$NATS_PID_FILE"

# --- 2. Health check via monitoring endpoint ---
RETRIES=20
until curl -fsS "http://127.0.0.1:${NATS_MONITOR_PORT}/healthz" >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "[init-local-nats] ERROR: NATS did not become healthy on port ${NATS_MONITOR_PORT}." >&2
    exit 1
  fi
  sleep 0.5
done

log "NATS ready at 127.0.0.1:${NATS_PORT} (monitor: ${NATS_MONITOR_PORT}, store: ${NATS_DATA_DIR})."
