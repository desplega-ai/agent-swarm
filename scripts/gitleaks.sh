#!/usr/bin/env bash
# Scan new git commits for secrets with a pinned, checksum-verified gitleaks.
#
# Used by the merge-gate `secret-scan` job and the prek `gitleaks` pre-push
# hook. This file owns the version and the hashes, so CI and local runs can't
# drift.
#
# Usage: bash scripts/gitleaks.sh [<git log range>]
#   Default range: $(git merge-base origin/main HEAD)..HEAD
#   Scans the git repo in the current directory. Only lines that a commit in
#   the range adds are scanned, so pre-existing secret-shaped lines on main
#   never block anyone.
#
# Findings are always printed with --redact: a finding never echoes the secret.
# Exit codes: 0 clean, 1 leaks found (or a gitleaks error), 2 setup failure.
#
# Intentional fixtures: build the value at runtime ("AKIA" + ...) or put an
# inline `gitleaks:allow` comment on the line. See .gitleaks.toml.
set -euo pipefail

# Bump the version and every hash together. Values come from
# https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256_LINUX_X64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
GITLEAKS_SHA256_LINUX_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
GITLEAKS_SHA256_DARWIN_ARM64=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
GITLEAKS_SHA256_DARWIN_X64=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config="${GITLEAKS_CONFIG:-$script_dir/../.gitleaks.toml}"

os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Linux/x86_64 | Linux/amd64) platform=linux_x64; expected_sha256="$GITLEAKS_SHA256_LINUX_X64" ;;
  Linux/aarch64 | Linux/arm64) platform=linux_arm64; expected_sha256="$GITLEAKS_SHA256_LINUX_ARM64" ;;
  Darwin/arm64) platform=darwin_arm64; expected_sha256="$GITLEAKS_SHA256_DARWIN_ARM64" ;;
  Darwin/x86_64) platform=darwin_x64; expected_sha256="$GITLEAKS_SHA256_DARWIN_X64" ;;
  *) echo "gitleaks.sh: unsupported platform $os/$arch" >&2; exit 2 ;;
esac

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/agent-swarm/gitleaks/$GITLEAKS_VERSION"
asset="gitleaks_${GITLEAKS_VERSION}_${platform}.tar.gz"
tarball="$cache_dir/$asset"
bin="$cache_dir/gitleaks"
mkdir -p "$cache_dir"

if [ ! -f "$tarball" ]; then
  url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${asset}"
  tmp=$(mktemp "$cache_dir/.download.XXXXXX")
  if ! curl -fsSL --retry 3 "$url" -o "$tmp"; then
    rm -f "$tmp"
    echo "gitleaks.sh: download failed: $url" >&2
    exit 2
  fi
  mv "$tmp" "$tarball"
fi

# Verify on every run, not only after download, so a corrupt or swapped cache
# entry is caught too. A mismatch is a hard failure.
actual_sha256=$(sha256_of "$tarball")
if [ "$actual_sha256" != "$expected_sha256" ]; then
  rm -f "$tarball" "$bin"
  echo "gitleaks.sh: SHA-256 mismatch for $asset" >&2
  echo "  expected $expected_sha256" >&2
  echo "  actual   $actual_sha256" >&2
  exit 2
fi
tmp_dir=$(mktemp -d "$cache_dir/.extract.XXXXXX")
tar -xzf "$tarball" -C "$tmp_dir" gitleaks
mv -f "$tmp_dir/gitleaks" "$bin"
rmdir "$tmp_dir"
chmod +x "$bin"

if [ $# -ge 1 ] && [ -n "$1" ]; then
  range="$1"
else
  if ! base=$(git merge-base origin/main HEAD 2> /dev/null); then
    echo "gitleaks.sh: no merge base with origin/main; run 'git fetch origin main' or pass a range" >&2
    exit 2
  fi
  range="$base..HEAD"
fi

echo "gitleaks $GITLEAKS_VERSION: scanning commits in $range"
exec "$bin" git \
  --log-opts="$range" \
  --config "$config" \
  --redact \
  --verbose \
  --no-banner \
  --exit-code 1 \
  .
