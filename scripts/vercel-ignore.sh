#!/bin/sh
# Vercel: 0 skips the build; 1 builds (including every Git error).
build() {
  echo "vercel-ignore: build ($1)"
  exit 1
}

cd "$(dirname "$0")/.." || build 'cannot enter repository root'
[ "$#" -gt 0 ] || build 'no input paths'
# Always read owners from fetched main, never from the proposed commit.
fetch_main() {
  # Vercel removes the clone's origin remote; this repository is public.
  remote=$(git remote get-url origin 2>/dev/null) || remote=https://github.com/desplega-ai/agent-swarm.git
  shallow=$(git rev-parse --is-shallow-repository) || return 1
  if [ "$shallow" = true ]; then
    git fetch --no-tags --unshallow "$remote" main || return 1
  else
    git fetch --no-tags "$remote" main || return 1
  fi
  main_ready=true
  echo 'vercel-ignore: fetch main succeeded'
}

if [ "${VERCEL_ENV:-}" = production ]; then
  echo 'vercel-ignore: author gate disabled (production)'
elif fetch_main; then
  if git cat-file -e FETCH_HEAD:.github/CODEOWNERS 2>/dev/null; then
    if owners=$(git show FETCH_HEAD:.github/CODEOWNERS); then
      if printf '%s\n' "$owners" | awk -v login="${VERCEL_GIT_COMMIT_AUTHOR_LOGIN:-}" '
        BEGIN { login = tolower(login) }
        /^[[:space:]]*#/ { next }
        { for (i = 2; i <= NF; i++) {
            if ($i ~ /^#/) break
            if ($i ~ /^@[A-Za-z0-9-]+$/ && tolower(substr($i, 2)) == login) found = 1
          }
        }
        END { exit !found }
      '; then
        echo 'vercel-ignore: author gate passed (listed owner)'
      else
        echo "vercel-ignore: skip (author '${VERCEL_GIT_COMMIT_AUTHOR_LOGIN:-}' is not a code owner on main)"
        exit 0
      fi
    else
      echo 'vercel-ignore: author gate disabled (cannot read CODEOWNERS on main)'
    fi
  else
    echo 'vercel-ignore: author gate disabled (CODEOWNERS missing on main or Git error)'
  fi
else
  echo 'vercel-ignore: author gate disabled (fetch main failed)'
fi

base=${VERCEL_GIT_PREVIOUS_SHA:-}
if [ -z "$base" ]; then
  echo 'vercel-ignore: previous SHA empty; using main for merge-base fallback'
  [ "${main_ready:-}" = true ] || fetch_main || build 'fetch main failed'
  base=$(git merge-base HEAD FETCH_HEAD) || build 'merge-base failed'
  [ -n "$base" ] || build 'merge-base empty'
  echo "vercel-ignore: merge-base resolved $base"
fi

git diff --quiet "$base" HEAD -- "$@" package.json bun.lock turbo.json
result=$?
case "$result" in
  0) echo 'vercel-ignore: skip (inputs unchanged)'; exit 0 ;;
  1) build 'inputs changed' ;;
  *) build 'diff failed' ;;
esac
