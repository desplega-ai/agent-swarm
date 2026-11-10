#!/usr/bin/env bash
# GitHub token for worker git and gh (installed as /usr/local/bin/swarm-github-token).
#
# Prints a GitHub App installation token minted by the swarm API
# (POST /api/github/installation-token) on every call. The API caches the token
# server-side, so nothing is written to disk: a same-uid process without the
# worker's API key (an ACP harness) finds no token file to read.
# When the API has no token, it falls back to the static PAT in the env.
#
#   swarm-github-token                  token on stdout (App token, else PAT)
#   swarm-github-token --app-only       App token only; exit 1 without one (boot probe)
#   swarm-github-token git-credential <get|store|erase>
#                                       git credential helper protocol
#
# The token is never logged and never put in a URL or argv. curl reads the API
# key from a stdin config, not from its command line.
set -u

mode="${1:-}"

pat() {
    printf '%s' "${GH_ENTERPRISE_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
}

app_token() {
    local api_key="${AGENT_SWARM_API_KEY:-${API_KEY:-}}"
    local base="${MCP_BASE_URL:-http://host.docker.internal:3013}"
    [ -n "$api_key" ] && [ -n "${AGENT_ID:-}" ] || return 1
    local body token
    body=$(printf 'header = "Authorization: Bearer %s"\nheader = "X-Agent-ID: %s"\n' "$api_key" "$AGENT_ID" |
        curl -sf --connect-timeout 3 --max-time 10 -X POST -H "Content-Type: application/json" \
            -d '{}' -K - "${base%/}/api/github/installation-token" 2>/dev/null) || return 1
    token=$(printf '%s' "$body" | jq -r '.token // empty' 2>/dev/null) || return 1
    [ -n "$token" ] || return 1
    printf '%s' "$token"
}

case "$mode" in
    --app-only)
        token=$(app_token) || exit 1
        printf '%s\n' "$token"
        ;;
    git-credential)
        action="${2:-}"
        cat > /dev/null
        case "$action" in
            get)
                token=$(app_token) || token=$(pat)
                [ -n "$token" ] || exit 0
                printf 'username=x-access-token\npassword=%s\n' "$token"
                ;;
            # store/erase: nothing is kept locally, so there is nothing to save or drop.
        esac
        ;;
    "")
        token=$(app_token) || token=$(pat)
        [ -n "$token" ] || exit 1
        printf '%s\n' "$token"
        ;;
    *)
        echo "usage: swarm-github-token [--app-only | git-credential <get|store|erase>]" >&2
        exit 2
        ;;
esac
