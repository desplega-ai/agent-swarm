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

# Refresh only the PGDG source. A full `apt-get update` fails when any other source of the
# machine is down (a GitHub runner has several), and that has nothing to do with PostgreSQL.
SRC="$(grep -rls "apt.postgresql.org" /etc/apt/sources.list.d/ | head -1)"
install_client() {
  $SUDO env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y -qq --no-install-recommends "postgresql-client-${MAJOR}"
}
if [ -n "$SRC" ]; then
  $SUDO apt-get update -qq -o Dir::Etc::sourcelist="$SRC" -o Dir::Etc::sourceparts="-" \
    -o APT::Get::List-Cleanup="0" >&2
fi
if [ -z "$SRC" ] || ! install_client >&2; then
  # A dependency from another source is not in the package lists (a bare image): refresh
  # every source. One broken source must not stop the install.
  $SUDO apt-get update -qq >&2 || echo "warning: one apt source did not update" >&2
  install_client >&2
fi

BIN="/usr/lib/postgresql/${MAJOR}/bin"
"$BIN/pg_dump" --version >&2
echo "$BIN"
