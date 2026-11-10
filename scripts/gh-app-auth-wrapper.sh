#!/usr/bin/env bash
# gh wrapper for GitHub App worker auth. The entrypoint puts its directory first
# on PATH only when the API mints installation tokens. Each call hands the real gh
# a current token (cached by swarm-github-token); on GHES gh reads
# GH_ENTERPRISE_TOKEN, on github.com GH_TOKEN. Without a token, gh runs as before.
real_gh="${SWARM_REAL_GH:-/usr/bin/gh}"
if token=$("${SWARM_GITHUB_TOKEN_BIN:-/usr/local/bin/swarm-github-token}" 2>/dev/null) && [ -n "$token" ]; then
    if [ -n "${GH_HOST:-}" ] && [ "$GH_HOST" != "github.com" ]; then
        export GH_ENTERPRISE_TOKEN="$token"
    else
        export GH_TOKEN="$token"
    fi
fi
exec "$real_gh" "$@"
