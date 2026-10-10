#!/usr/bin/env bash
# Runs the Claude Code mod's tests (claude-mod/tests/*.mod-test.ts) with
# `claude plugin test`. The plugin root is the repo root, and `claude plugin
# test` runs every *.test.ts under its folder, so this copies the manifest and
# claude-mod/ into a temp plugin and names the tests *.test.ts only there.
# Needs the `claude` CLI (2.1.287 or later) on PATH.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.claude-plugin" "$tmp/claude-mod/tests"
cp "$root/.claude-plugin/plugin.json" "$tmp/.claude-plugin/"
for item in "$root"/claude-mod/*; do
  [ "$(basename "$item")" = "tests" ] || cp -R "$item" "$tmp/claude-mod/"
done
for test_file in "$root"/claude-mod/tests/*.mod-test.ts; do
  name="$(basename "$test_file" .mod-test.ts)"
  cp "$test_file" "$tmp/claude-mod/tests/$name.test.ts"
done
claude plugin test "$tmp"
