#!/usr/bin/env bash
# init-local-postgres.sh
#
# Idempotent: safe to call on every container start.
# Initializes and starts an embedded PostgreSQL 16 cluster for integration tests.
#
# Must run as root (before gosu-drop); uses `gosu worker` for PG commands so
# the cluster is owned by the worker user, not root.
#
# Configuration (all have defaults; override via env vars in deployment config):
#   LOCAL_POSTGRES_DATA_DIR  — cluster data directory  (default: /tmp/postgres-test)
#   ENABLE_LOCAL_POSTGRES    — set to "true" to activate  (defaulted by role in entrypoint)
set -euo pipefail

PG_VERSION=16
PG_BINDIR="/usr/lib/postgresql/${PG_VERSION}/bin"
PG_CLUSTER_DIR="${LOCAL_POSTGRES_DATA_DIR:-/tmp/postgres-test}"
PG_DATA_DIR="${PG_CLUSTER_DIR}/data"
PG_LOG="${PG_CLUSTER_DIR}/postgres.log"
PG_PORT=5433
PG_USER=prisma
PG_PASSWORD=prisma
PG_DB=tests

log() { printf '[init-local-postgres] %s\n' "$1"; }

# Ensure cluster dir is owned by worker (this script runs as root)
mkdir -p "$PG_CLUSTER_DIR"
chown -R worker:worker "$PG_CLUSTER_DIR"

# --- 1. Init cluster if not already initialized ---
if [ ! -s "${PG_DATA_DIR}/PG_VERSION" ]; then
  log "Initializing PostgreSQL ${PG_VERSION} cluster at ${PG_DATA_DIR}"
  gosu worker "${PG_BINDIR}/initdb" \
    -D "$PG_DATA_DIR" \
    --username="$PG_USER" \
    --auth-host=trust \
    --auth-local=trust \
    > /dev/null

  # Append runtime config overrides
  {
    printf "listen_addresses = '127.0.0.1'\n"
    printf "port = %s\n" "$PG_PORT"
    printf "unix_socket_directories = '%s'\n" "$PG_CLUSTER_DIR"
    printf "max_connections = 200\n"
    printf "fsync = off\n"
    printf "shared_preload_libraries = 'pg_stat_statements'\n"
  } >> "${PG_DATA_DIR}/postgresql.conf"

  # Trust all localhost connections (ephemeral test cluster — no secrets at risk)
  cat > "${PG_DATA_DIR}/pg_hba.conf" <<EOF
local   all   all              trust
host    all   all   127.0.0.1/32   trust
host    all   all   ::1/128        trust
EOF

  # Set password for the superuser role so client-monorepo's SCRAM connections work
  gosu worker "${PG_BINDIR}/pg_ctl" -D "$PG_DATA_DIR" -l "$PG_LOG" start -w -t 60 > /dev/null
  gosu worker "${PG_BINDIR}/psql" \
    -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres \
    -c "ALTER USER ${PG_USER} PASSWORD '${PG_PASSWORD}';" > /dev/null
  log "Cluster initialized."
else
  # --- 2. Start server if not already running ---
  if ! gosu worker "${PG_BINDIR}/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" > /dev/null 2>&1; then
    # Remove stale postmaster.pid from a previous unclean shutdown
    rm -f "${PG_DATA_DIR}/postmaster.pid"
    log "Starting PostgreSQL ${PG_VERSION} on port ${PG_PORT}..."
    gosu worker "${PG_BINDIR}/pg_ctl" -D "$PG_DATA_DIR" -l "$PG_LOG" start -w -t 60 > /dev/null
    log "PostgreSQL started."
  else
    log "PostgreSQL already running on port ${PG_PORT}."
  fi
fi

# --- 3. Create the 'tests' template database if absent ---
DB_EXISTS=$(gosu worker "${PG_BINDIR}/psql" \
  -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres \
  -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" 2>/dev/null || echo "")
if [ "$DB_EXISTS" != "1" ]; then
  log "Creating database '${PG_DB}'..."
  gosu worker "${PG_BINDIR}/createdb" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" "$PG_DB"
  log "Database '${PG_DB}' created."
fi

log "Local PostgreSQL ready at localhost:${PG_PORT} (data dir: ${PG_CLUSTER_DIR})."
