#!/bin/sh
# Exercise the author gate against fetched main in a disposable local repository.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
git init -q -b main "$tmp/main"
cd "$tmp/main"
git config user.email test@example.com
git config user.name Test
mkdir -p .github scripts apps/ui
cp "$root/scripts/vercel-ignore.sh" scripts/
cp "$root/.github/vercel-build-owners" .github/
echo base > apps/ui/input
git add .
git commit -qm base
base=$(git rev-parse HEAD)
git clone -q "$tmp/main" "$tmp/preview"
cd "$tmp/preview"
git config user.email test@example.com
git config user.name Test
git checkout -qb preview
echo changed >> apps/ui/input
git add .
git commit -qm change
export VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=preview
export VERCEL_GIT_PREVIOUS_SHA="$base"
unset VERCEL_PROJECT_ID VERCEL_GIT_COMMIT_MESSAGE

check() {
  expected=$1
  message=$2
  status=0
  sh scripts/vercel-ignore.sh apps/ui > "$tmp/output" 2>&1 || status=$?
  if [ "$status" -ne "$expected" ] || ! grep -Fq "$message" "$tmp/output"; then
    cat "$tmp/output"
    echo "FAIL: expected exit $expected and $message" >&2
    exit 1
  fi
  echo "PASS: $message"
}

export VERCEL_GIT_COMMIT_AUTHOR_LOGIN=outsider
check 0 "author 'outsider' is not a build owner on main"
export VERCEL_GIT_COMMIT_AUTHOR_LOGIN=tarasyarema
check 1 'author gate passed (listed owner)'
export VERCEL_GIT_COMMIT_AUTHOR_LOGIN=outsider
# A proposed owner edit must not grant permission.
echo '* @outsider' > .github/vercel-build-owners
git add .
git commit -qm 'proposed owner change'
check 0 "author 'outsider' is not a build owner on main"
export VERCEL_ENV=production
check 1 'author gate disabled (production)'
export VERCEL_ENV=preview VERCEL_GIT_COMMIT_AUTHOR_LOGIN=TarasYarema
check 1 'author gate passed (listed owner)'
export VERCEL_GIT_PREVIOUS_SHA
VERCEL_GIT_PREVIOUS_SHA=$(git rev-parse HEAD)
check 0 'inputs unchanged'
export VERCEL_GIT_PREVIOUS_SHA="$base" VERCEL_GIT_COMMIT_AUTHOR_LOGIN=outsider
# Before the rename lands on main, missing owners disable only the author gate.
cd "$tmp/main"
git mv .github/vercel-build-owners .github/CODEOWNERS
git commit -qm 'legacy owner path'
cd "$tmp/preview"
check 1 'author gate disabled (vercel-build-owners missing on main or Git error)'
# Production bypasses fetching owners, even when the remote is unavailable.
git remote set-url origin "$tmp/missing"
export VERCEL_ENV=production
check 1 'author gate disabled (production)'
export VERCEL_ENV=preview
check 1 'author gate disabled (fetch main failed)'
