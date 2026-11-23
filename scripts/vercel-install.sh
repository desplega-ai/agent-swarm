#!/bin/sh
# Vercel install for apps/ui (projects agent-swarm and agent-swarm-demo).
# Vercel restores node_modules from the last build, and `bun install` does not
# remove a package that the lockfile no longer nests under the workspace. When
# a bump dedupes apps/ui/node_modules/<pkg> into the root, the stale nested copy
# stays and tsc resolves two versions of one package. Drop the workspace's own
# node_modules so it matches a fresh install; the root one keeps the cache.
set -eu
cd "$(dirname "$0")/../apps/ui"
rm -rf node_modules
exec bun install
