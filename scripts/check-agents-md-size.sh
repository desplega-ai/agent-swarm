#!/usr/bin/env bash
# Agent instruction files (CLAUDE.md, AGENTS.md) must fit the harnesses that load them.
# A harness cuts an oversized file with no error, so the agent works without the rules
# at the end of it.
#
# - Codex loads at most 32,768 bytes (`project_doc_max_bytes`) from the AGENTS.md files
#   between the repo root and its start directory. It truncates the file that crosses the
#   cap and skips every file after it.
# - Other harnesses cap one file lower (Antigravity: 24,000 bytes).
#
# Rule 1: one agent file is at most FILE_MAX bytes.
# Rule 2: an agent file plus the agent files of its parent directories is at most CHAIN_MAX.
#
# Fix a failure by moving detail to a runbook and leaving the rule and a pointer.
# `templates/` holds agent files for other workspaces, so it is out of scope.
set -euo pipefail

FILE_MAX=24000
CHAIN_MAX=32768

cd "$(git rev-parse --show-toplevel)"

# The real file of a directory: CLAUDE.md, or AGENTS.md when it is not a symlink to it.
agent_file() {
  local dir=$1 name
  for name in CLAUDE.md AGENTS.md; do
    if [ -f "$dir/$name" ] && [ ! -L "$dir/$name" ]; then
      echo "$dir/$name"
      return
    fi
  done
}

size_of() { wc -c <"$1" | tr -d ' '; }

fail=0
while IFS= read -r file; do
  [ -L "$file" ] && continue
  size=$(size_of "$file")
  bad=0
  if [ "$size" -gt "$FILE_MAX" ]; then
    echo "FAIL $file: $size bytes. One agent file may hold at most $FILE_MAX bytes." >&2
    bad=1
  fi
  chain=$size
  dir=$(dirname "$file")
  while [ "$dir" != "." ]; do
    dir=$(dirname "$dir")
    parent=$(agent_file "$dir")
    if [ -n "$parent" ]; then chain=$((chain + $(size_of "$parent"))); fi
  done
  if [ "$chain" -gt "$CHAIN_MAX" ]; then
    echo "FAIL $file: $chain bytes together with the agent files of its parent directories. Codex loads at most $CHAIN_MAX bytes of that chain." >&2
    bad=1
  fi
  if [ "$bad" -eq 0 ]; then echo "ok   $file: $size bytes (chain $chain)"; else fail=1; fi
done < <(git ls-files -- 'CLAUDE.md' 'AGENTS.md' '*/CLAUDE.md' '*/AGENTS.md' ':!templates/')

if [ "$fail" -ne 0 ]; then
  echo "Move detail to a runbook and leave the rule and a pointer in the agent file." >&2
  exit 1
fi
