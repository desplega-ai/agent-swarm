#!/usr/bin/env bash
# Self-test for scripts/gitleaks.sh. Proves the scanner is wired, not just
# installed:
#   1. A commit that adds an AWS-shaped key pair fails the scan (exit 1), and
#      the output names the rule but never contains the key (proves --redact).
#   2. A commit that adds a clean file passes (exit 0).
#
# The fake key is built at runtime from random characters, so this file holds
# no secret-shaped literal for gitleaks or GitHub push protection to flag.
#
# Usage: bash scripts/gitleaks-selftest.sh
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
scanner="$script_dir/gitleaks.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  echo "gitleaks-selftest: FAIL: $*" >&2
  exit 1
}

# Random characters from a set. `|| true` absorbs tr's SIGPIPE under pipefail.
random_chars() {
  local set="$1" len="$2" out
  out=$(LC_ALL=C tr -dc "$set" < /dev/urandom | head -c "$len" || true)
  [ "${#out}" -eq "$len" ] || fail "could not generate $len random characters"
  printf '%s' "$out"
}

git_in() {
  local dir="$1"
  shift
  git -C "$dir" -c user.name=selftest -c user.email=selftest@example.invalid \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"
}

# Creates a repo with an empty base commit, then commits $2 as file $3.
# Prints the base SHA, so the scan range is exactly the one added commit.
make_repo() {
  local dir="$1" content="$2" file="$3"
  mkdir -p "$dir"
  git_in "$dir" init -q
  git_in "$dir" commit -q --allow-empty -m base
  git_in "$dir" rev-parse HEAD
  printf '%s\n' "$content" > "$dir/$file"
  git_in "$dir" add "$file"
  git_in "$dir" commit -q -m add
}

# 1. Leaky commit: must exit 1 and must not print the key. A download or
# checksum failure exits 2, so it cannot pass as a finding.
key_id="AKIA$(random_chars 'A-Z2-7' 16)"
key_secret="$(random_chars 'A-Za-z0-9' 40)"
leaky="$work/leaky"
base=$(make_repo "$leaky" "aws_access_key_id = $key_id
aws_secret_access_key = $key_secret" credentials.ini)

set +e
output=$(cd "$leaky" && bash "$scanner" "$base..HEAD" 2>&1)
status=$?
set -e
[ "$status" -eq 1 ] || fail "leaky commit: expected exit 1, got $status. Output: $output"
grep -q 'aws-access-token' <<< "$output" || fail "leaky commit: no aws-access-token finding. Output: $output"
grep -q 'REDACTED' <<< "$output" || fail "leaky commit: no REDACTED marker in output"
if grep -qF "$key_id" <<< "$output" || grep -qF "$key_secret" <<< "$output"; then
  fail "leaky commit: the key appeared in scanner output (--redact is not applied)"
fi
echo "gitleaks-selftest: ok: leaky commit blocked (exit 1), key redacted"

# 2. Clean commit on a fresh repo: must exit 0.
clean="$work/clean"
base=$(make_repo "$clean" "just a plain config line = 42" notes.txt)
set +e
output=$(cd "$clean" && bash "$scanner" "$base..HEAD" 2>&1)
status=$?
set -e
[ "$status" -eq 0 ] || fail "clean commit: expected exit 0, got $status. Output: $output"
echo "gitleaks-selftest: ok: clean commit passes (exit 0)"
