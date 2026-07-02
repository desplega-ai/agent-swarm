#!/bin/bash
# Enforce the monorepo layout (Monorepo 01–03, DES-647..649).
#
# The old top-level app locations were git-mv'd:
#   src/          -> apps/swarm/src/
#   ui/           -> apps/ui/
#   templates-ui/ -> apps/templates-ui/
#   evals/        -> apps/evals/
#
# The classic failure mode this guards against: a branch created before the
# moves gets rebased/merged carelessly and RESURRECTS an old directory — the
# code lands in a location nothing builds, lints, tests, or ships, and merges
# green while being completely dead. Fail loudly instead.

set -euo pipefail

DEAD_PATHS=(src ui templates-ui evals)
VIOLATIONS=""

for path in "${DEAD_PATHS[@]}"; do
  MATCHES=$(git ls-files -- "${path}/" | head -5 || true)
  if [ -n "$MATCHES" ]; then
    VIOLATIONS="${VIOLATIONS}Tracked files under dead top-level '${path}/' (moved to apps/):\n${MATCHES}\n"
  fi
done

# The canonical locations must exist (catches the inverse mistake too).
for path in apps/swarm/src apps/ui apps/templates-ui apps/evals; do
  if [ ! -d "$path" ]; then
    VIOLATIONS="${VIOLATIONS}Expected app directory missing: ${path}\n"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Monorepo layout violation!"
  echo ""
  echo "The pre-monorepo top-level directories are dead — everything lives under apps/ now."
  echo "This usually means a branch predating the moves was rebased/merged without"
  echo "following the renames. Move the files to their apps/* location instead."
  echo ""
  echo -e "$VIOLATIONS"
  exit 1
fi

echo "OK: Monorepo layout intact (no resurrected top-level dirs; apps/* present)."
