#!/usr/bin/env bash
# Stress pack for a stack made with `stack.sh up`: saved scripts, workflows and schedules
# that run without any LLM and exercise edge cases and concurrent work. Each piece checks
# its own result and writes a record to KV (namespace `stress`).
#
#   stress-pack.sh install <run> [--level N]   save the scripts, workflows and schedules, switch the pack on
#   stress-pack.sh status  <run> [--json]      print the scoreboard and the schedule states
#   stress-pack.sh pause   <run>               kill switch: KV stress/enabled=false, schedules disabled
#   stress-pack.sh resume  <run>               switch the pack on again
#   stress-pack.sh level   <run> <1|2|3>       intensity: scripts read it on their next run
#   stress-pack.sh reset   <run>               clear the result records and the counters
#   stress-pack.sh remove  <run>               delete every schedule, workflow, script, memory and KV key of the pack
#
# Maintainer commands: `upsert <run> [script]`, `workflows <run>`, `run <run> <script> [args-json]`,
# `trigger <run> <workflow> [trigger-json]`, `fire <run> <schedule>`.
#
# Every API call runs on the box, so the API key never leaves it. Needs bun on this machine.
# Sources: ../stress-pack/ (scripts/*.ts, workflows/*.json, schedules.json).
set -euo pipefail

usage() { sed -n '2,17p' "$0"; exit 2; }
[ $# -ge 2 ] || usage
command -v bun >/dev/null || { echo "bun is required (https://bun.sh)" >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$here/../stress-pack/pack.ts" "$@"
