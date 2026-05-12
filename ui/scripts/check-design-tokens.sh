#!/usr/bin/env bash
# Design-token lint gate for ui/src/.
#
# Fails on any raw Tailwind color palette literal, arbitrary color literal,
# `dark:` palette variant, or hardcoded hex (outside the Monaco themes allowlist).
#
# Phase 7 of the design-system migration plan; see ui/CLAUDE.md "Theming".

set -euo pipefail

cd "$(dirname "$0")/.."

VIOLATIONS=0

# ANSI color codes (only emit when stdout is a TTY)
if [ -t 1 ]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=""
  GREEN=""
  BOLD=""
  RESET=""
fi

# Color palette + utility prefix lists shared across checks.
PALETTE='zinc|slate|gray|stone|neutral|emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime'
PREFIXES='bg|text|border|fill|stroke|ring|from|via|to|shadow'

check() {
  local label="$1"
  local pattern="$2"
  shift 2
  local extra_args=("$@")

  echo ""
  echo "${BOLD}▶ Checking: ${label}${RESET}"

  local matches
  if matches=$(rg -n --color never "$pattern" "${extra_args[@]}" src/ 2>/dev/null); then
    echo "${RED}✖ FAIL: ${label}${RESET}"
    echo "$matches"
    VIOLATIONS=$((VIOLATIONS + 1))
  else
    echo "${GREEN}✓ OK: ${label}${RESET}"
  fi
}

check "Tailwind palette literals (e.g. bg-zinc-500)" \
  "(${PREFIXES})-(${PALETTE})-[0-9]"

check "Tailwind dark: palette literals (e.g. dark:text-amber-400)" \
  "dark:(${PREFIXES})-(${PALETTE})-[0-9]"

check "Tailwind arbitrary color literals (e.g. bg-[#0d1117])" \
  "(${PREFIXES})-\[#[0-9a-fA-F]+\]"

check "Hardcoded hex literals outside src/lib/monaco-themes.ts" \
  '#[0-9a-fA-F]{6}' \
  -g '*.ts' -g '*.tsx' -g '!**/monaco-themes.ts'

echo ""
if [ "$VIOLATIONS" -gt 0 ]; then
  echo "${RED}${BOLD}✖ ${VIOLATIONS} design-token check(s) failed.${RESET}"
  echo "  See ui/CLAUDE.md \"Theming\" — use semantic tokens from src/styles/globals.css."
  exit 1
fi

echo "${GREEN}${BOLD}✓ All design-token checks passed.${RESET}"
exit 0
