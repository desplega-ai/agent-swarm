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
#   swarm-github-token --repo <owner/name>
#                                       token for that repo's installation; exit 1 without one
#   swarm-github-token git-credential <get|store|erase>
#                                       git credential helper protocol
#
# The repository comes from `--repo`, from the git credential request (`url=`,
# or `host=` plus `path=`), or from SWARM_GITHUB_TOKEN_REPO. The API resolves
# that repository's App installation, so one App with an installation per owner
# serves more than one account. A call that names no repo mints for
# GITHUB_APP_INSTALLATION_ID exactly as before.
#
# The token is never logged and never put in a URL or argv. curl reads the API
# key from a stdin config, not from its command line.
set -u

mode="${1:-}"
repo="${SWARM_GITHUB_TOKEN_REPO:-}"

pat() {
    printf '%s' "${GH_ENTERPRISE_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
}

# JSON-safe `owner/name`: exactly one slash and nothing a JSON reader would
# reinterpret. Anything else gets no App token, so the API never receives it.
safe_repo() {
    case "$1" in
        */*/*|/*|*/) return 1 ;;
        *[!A-Za-z0-9._/-]*) return 1 ;;
        */*) return 0 ;;
        *) return 1 ;;
    esac
}

# `owner/name` from a git credential request: `url=https://host/owner/name.git`
# when git was handed a URL, else `host=` plus `path=owner/name.git`.
repo_from_credentials() {
    local found=""
    found=$(printf '%s\n' "$1" | sed -n 's#^url=.*[/:]\([^/]*/[^/]*\)$#\1#p' | sed 's/\.git$//')
    if [ -z "$found" ]; then
        found=$(printf '%s\n' "$1" | sed -n 's#^path=\(..*\)$#\1#p' | sed 's#^/*##; s/\.git$//')
    fi
    printf '%s' "$found"
}

app_token() {
    local target="${1:-}"
    local api_key="${AGENT_SWARM_API_KEY:-${API_KEY:-}}"
    local base="${MCP_BASE_URL:-http://host.docker.internal:3013}"
    [ -n "$api_key" ] && [ -n "${AGENT_ID:-}" ] || return 1
    local payload='{}'
    if [ -n "$target" ]; then
        # A named repo that is not `owner/name` gets no App token (the caller
        # falls back to the PAT), never the deployment-wide installation's.
        safe_repo "$target" || return 1
        payload=$(printf '{"repo":"%s"}' "$target")
    fi
    local body token
    body=$(printf 'header = "Authorization: Bearer %s"\nheader = "X-Agent-ID: %s"\n' "$api_key" "$AGENT_ID" |
        curl -sf --connect-timeout 3 --max-time 10 -X POST -H "Content-Type: application/json" \
            -d "$payload" -K - "${base%/}/api/github/installation-token" 2>/dev/null) || return 1
    token=$(printf '%s' "$body" | jq -r '.token // empty' 2>/dev/null) || return 1
    [ -n "$token" ] || return 1
    printf '%s' "$token"
}

case "$mode" in
    --app-only)
        token=$(app_token "$repo") || exit 1
        printf '%s\n' "$token"
        ;;
    --repo)
        [ -n "${2:-}" ] || {
            echo "usage: swarm-github-token --repo <owner/name>" >&2
            exit 2
        }
        token=$(app_token "$2") || token=$(pat)
        [ -n "$token" ] || exit 1
        printf '%s\n' "$token"
        ;;
    git-credential)
        action="${2:-}"
        input=$(cat)
        case "$action" in
            get)
                target=$(repo_from_credentials "$input")
                [ -n "$target" ] || target="$repo"
                token=$(app_token "$target") || token=$(pat)
                [ -n "$token" ] || exit 0
                printf 'username=x-access-token\npassword=%s\n' "$token"
                ;;
            # store/erase: nothing is kept locally, so there is nothing to save or drop.
        esac
        ;;
    "")
        token=$(app_token "$repo") || token=$(pat)
        [ -n "$token" ] || exit 1
        printf '%s\n' "$token"
        ;;
    *)
        echo "usage: swarm-github-token [--app-only | --repo <owner/name> | git-credential <get|store|erase>]" >&2
        exit 2
        ;;
esac
