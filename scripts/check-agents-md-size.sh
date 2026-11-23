#!/usr/bin/env bash
# Agent instruction files (CLAUDE.md, AGENTS.md) must fit what Codex loads.
#
# Codex spends one budget of 32,768 bytes (`project_doc_max_bytes`) on the AGENTS.md files
# between the repo root and its start directory. It truncates the file that crosses the
# budget and skips every file after it, with only a startup warning. In each directory it
# reads `AGENTS.override.md`, else `AGENTS.md`, and it follows symlinks.
#
# Rule 1: one agent file is at most FILE_MAX bytes. This is the repo's editorial budget:
#         it leaves CHAIN_MAX - FILE_MAX bytes of the Codex budget for one nested file.
# Rule 2: an agent file plus the agent files of its parent directories is at most CHAIN_MAX.
# Rule 3: one layout only, so that this check and every harness read the same bytes:
#         a real `CLAUDE.md` with `AGENTS.md` as a symlink to it. No `AGENTS.override.md`.
#
# Fix a size failure by moving detail to a runbook and leaving the rule and a pointer.
# `templates/` holds agent files for other workspaces, so it is out of scope.
set -euo pipefail

FILE_MAX=24000
CHAIN_MAX=32768

cd "$(git rev-parse --show-toplevel)"

size_of() { wc -c <"$1" | tr -d ' '; }

fail=0
problem() {
  echo "FAIL $1" >&2
  fail=1
}

while IFS= read -r file; do
  problem "$file: AGENTS.override.md is not supported. Codex reads it in place of AGENTS.md, and this check does not."
done < <(git ls-files -- 'AGENTS.override.md' '*/AGENTS.override.md' ':!templates/')

while IFS= read -r file; do
  dir=$(dirname "$file")
  if [ -L "$file" ]; then
    problem "$file: CLAUDE.md is the real file. Make AGENTS.md the symlink."
    continue
  fi
  before=$fail
  if [ ! -L "$dir/AGENTS.md" ] || [ "$(readlink "$dir/AGENTS.md")" != "CLAUDE.md" ]; then
    problem "$file: $dir/AGENTS.md must be a symlink to CLAUDE.md (ln -s CLAUDE.md AGENTS.md), so that Codex reads the same file."
  fi
  size=$(size_of "$file")
  if [ "$size" -gt "$FILE_MAX" ]; then
    problem "$file: $size bytes. One agent file may hold at most $FILE_MAX bytes."
  fi
  chain=$size
  while [ "$dir" != "." ]; do
    dir=$(dirname "$dir")
    if [ -f "$dir/CLAUDE.md" ]; then chain=$((chain + $(size_of "$dir/CLAUDE.md"))); fi
  done
  if [ "$chain" -gt "$CHAIN_MAX" ]; then
    problem "$file: $chain bytes together with the agent files of its parent directories. Codex loads at most $CHAIN_MAX bytes of that chain."
  fi
  if [ "$fail" -eq "$before" ]; then
    echo "ok   $file: $size bytes (chain $chain, $((CHAIN_MAX - chain)) bytes left for Codex)"
  fi
done < <(git ls-files -- 'CLAUDE.md' '*/CLAUDE.md' ':!templates/')

# A directory with AGENTS.md and no CLAUDE.md is outside the one supported layout.
while IFS= read -r file; do
  if [ ! -e "$(dirname "$file")/CLAUDE.md" ]; then
    problem "$file: no CLAUDE.md beside it. Keep the text in CLAUDE.md and make AGENTS.md a symlink to it."
  fi
done < <(git ls-files -- 'AGENTS.md' '*/AGENTS.md' ':!templates/')

if [ "$fail" -ne 0 ]; then
  echo "See the rules at the top of scripts/check-agents-md-size.sh." >&2
  exit 1
fi
