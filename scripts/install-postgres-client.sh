#!/bin/bash
# Installs the PostgreSQL client tools of one major version (default 18) from the
# PGDG apt repository on Ubuntu or Debian, and prints their bin directory.
#
# Why: pg_dump refuses a server with a newer major version. The ubuntu-24.04 runner
# ships the PostgreSQL 16 client, and the CI service runs PostgreSQL 18, so the
# storage-recovery scenario needs the 18 client.
#
# Usage: bash scripts/install-postgres-client.sh [major]
#   In GitHub Actions: bash scripts/install-postgres-client.sh 18 >> "$GITHUB_PATH"
# Runs apt with sudo when it is not root.
set -euo pipefail

MAJOR="${1:-18}"
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# Add the PGDG repository only when no apt source names it yet. A second entry for the
# same repository with another signing key makes `apt-get update` fail.
if ! grep -rqs "apt.postgresql.org" /etc/apt/sources.list /etc/apt/sources.list.d/; then
  KEY=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  $SUDO install -d "$(dirname "$KEY")"
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | $SUDO tee "$KEY" > /dev/null
  echo "deb [signed-by=$KEY] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    | $SUDO tee /etc/apt/sources.list.d/pgdg.list > /dev/null
fi

$SUDO apt-get update -qq >&2
$SUDO env DEBIAN_FRONTEND=noninteractive \
  apt-get install -y -qq --no-install-recommends "postgresql-client-${MAJOR}" >&2

BIN="/usr/lib/postgresql/${MAJOR}/bin"
"$BIN/pg_dump" --version >&2
echo "$BIN"
