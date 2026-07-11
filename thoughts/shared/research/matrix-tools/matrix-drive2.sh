#!/bin/bash
# Matrix phase 2: claude+seeds, then pi and opencode (deepseek-v4-flash) full vs scripts-only+seeds.
set -u
cd /Users/taras/Documents/code/agent-swarm

run() {
  echo "======== RUN $* start $(date -u +%FT%TZ) ========"
  bun /tmp/matrix-run.ts "$@"
  echo "======== RUN $* exit=$? $(date -u +%FT%TZ) ========"
}

for n in 1 2 3; do run scripts-only "$n" claude seeds; done
for n in 1 2 3; do
  run full "$n" pi
  run scripts-only "$n" pi seeds
done
for n in 1 2 3; do
  run full "$n" opencode
  run scripts-only "$n" opencode seeds
done

echo "MATRIX2 DONE"
SCRIPTS_ONLY_MCP=true docker compose -f docker-compose.scripts-only.yml down -v --remove-orphans
