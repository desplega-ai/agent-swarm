#!/bin/bash
# Drive the 2x3 matrix: alternate scripts-only / full, 3 runs each. No image rebuilds.
set -u
cd /Users/taras/Documents/code/agent-swarm
for n in 1 2 3; do
  for mode in scripts-only full; do
    echo "======== RUN $mode-$n start $(date -u +%FT%TZ) ========"
    bun /tmp/matrix-run.ts "$mode" "$n"
    echo "======== RUN $mode-$n exit=$? $(date -u +%FT%TZ) ========"
  done
done
echo "MATRIX DONE"
# leave the last stack down to free resources
SCRIPTS_ONLY_MCP=true docker compose -f docker-compose.scripts-only.yml down -v --remove-orphans
