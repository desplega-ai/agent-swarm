#!/usr/bin/env bash
# Claude Code PostToolUse hook (.claude/settings.json, Edit|Write|MultiEdit):
# runs `biome format --write` on the edited file when CI lints it with Biome.
# Best effort: it always exits 0 and never blocks an edit.
#
# Scope matches scripts/check.sh: directories outside it are not Biome-formatted
# today, and reformatting a whole file there would be drive-by churn.
BIOME_SCOPE='^(src/|apps/evals/|apps/ui/|packages/ui-e2e/|packages/model-routing/)'

{
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 0
  biome="$root/node_modules/.bin/biome"
  [[ -x "$biome" ]] || exit 0
  file=$(bun -e 'const j = await Bun.stdin.json(); console.log(j?.tool_input?.file_path ?? "")') || exit 0
  [[ -n "$file" && -f "$file" ]] || exit 0
  case "$file" in
    "$root"/*) rel=${file#"$root"/} ;;
    *) exit 0 ;;
  esac
  grep -Eq "$BIOME_SCOPE" <<<"$rel" || exit 0
  cd "$root" || exit 0
  limit=()
  if command -v timeout >/dev/null; then limit=(timeout 20); fi
  "${limit[@]}" "$biome" format --write --no-errors-on-unmatched --files-ignore-unknown=true "$rel"
} >/dev/null 2>&1

exit 0
