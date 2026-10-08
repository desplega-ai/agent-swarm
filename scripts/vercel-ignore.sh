#!/bin/sh
# Vercel: 0 skips the build; 1 builds (including every Git error).
build() {
  echo "vercel-ignore: build ($1)"
  exit 1
}

cd "$(dirname "$0")/.." || build 'cannot enter repository root'
[ "$#" -gt 0 ] || build 'no input paths'
base=${VERCEL_GIT_PREVIOUS_SHA:-}
if [ -z "$base" ]; then
  echo 'vercel-ignore: previous SHA empty; fetching main for merge-base fallback'
  # Vercel removes the clone's origin remote; this repository is public.
  remote=$(git remote get-url origin 2>/dev/null) || remote=https://github.com/desplega-ai/agent-swarm.git
  shallow=$(git rev-parse --is-shallow-repository) || build 'cannot inspect clone'
  if [ "$shallow" = true ]; then
    git fetch --no-tags --unshallow "$remote" main || build 'fetch main failed'
  else
    git fetch --no-tags "$remote" main || build 'fetch main failed'
  fi
  echo 'vercel-ignore: fetch main succeeded'
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
