#!/bin/sh
# agent-swarm prek template shim (install-repo-hooks.sh replaces this file by its marker line).
#
# Worker images set `init.templateDir` so git copies this pre-push hook into every
# new clone, including ad-hoc ones (`mktemp -d && gh repo clone ...`) that never
# pass through install-repo-hooks.sh. It runs prek only when all of these hold,
# and is a silent no-op otherwise:
#   - prek is on PATH
#   - the checkout has a prek.toml or .pre-commit-config.yaml
#   - origin is a repo registered with hooks enabled (git config
#     `agent-swarm.prekHookRepo`, one host/owner/name value per repo, written by
#     docker-entrypoint.sh)

command -v prek >/dev/null 2>&1 || exit 0

top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -f "$top/prek.toml" ] || [ -f "$top/.pre-commit-config.yaml" ] || exit 0

origin="$(git remote get-url origin 2>/dev/null)" || exit 0
# https://user:token@github.com/o/r.git and git@github.com:o/r.git -> github.com/o/r
slug="$(printf '%s\n' "$origin" | sed -e 's#^[A-Za-z+]*://##' -e 's#^[^@/]*@##' -e 's#:#/#' -e 's#\.git$##' -e 's#/*$##' | tr 'A-Z' 'a-z')"
git config --get-all agent-swarm.prekHookRepo 2>/dev/null | tr 'A-Z' 'a-z' | grep -qxF "$slug" || exit 0

HERE="$(cd "$(dirname "$0")" && pwd)"
exec prek hook-impl --hook-dir "$HERE" --hook-type=pre-push --skip-on-missing-config -- "$@"
