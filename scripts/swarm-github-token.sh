#!/usr/bin/env bash
# GitHub token for worker git and gh (installed as /usr/local/bin/swarm-github-token).
#
# Prints a GitHub App installation token minted by the swarm API
# (POST /api/github/installation-token), cached until 5 minutes before expiry.
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
cache_dir="${SWARM_GITHUB_TOKEN_CACHE_DIR:-/tmp/swarm-github-token-$(id -u)}"
cache_file="${cache_dir}/token"
refresh_seconds="${SWARM_GITHUB_TOKEN_REFRESH_SECONDS:-300}"

pat() {
    printf '%s' "${GH_ENTERPRISE_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
}

# Cache holds "<expiry epoch> <token>". Used only from a dir we own (mode 700).
cache_usable() {
    [ -d "$cache_dir" ] && [ -O "$cache_dir" ] && [ ! -L "$cache_dir" ]
}

read_cache() {
    cache_usable && [ -f "$cache_file" ] || return 1
    local expires token
    read -r expires token < "$cache_file" || return 1
    case "$expires" in ''|*[!0-9]*) return 1 ;; esac
    [ -n "$token" ] && [ "$expires" -gt "$(( $(date +%s) + refresh_seconds ))" ] || return 1
    printf '%s' "$token"
}

fetch_app_token() {
    local api_key="${AGENT_SWARM_API_KEY:-${API_KEY:-}}"
    local base="${MCP_BASE_URL:-http://host.docker.internal:3013}"
    [ -n "$api_key" ] && [ -n "${AGENT_ID:-}" ] || return 1
    local body token expires_at expires
    body=$(printf 'header = "Authorization: Bearer %s"\nheader = "X-Agent-ID: %s"\n' "$api_key" "$AGENT_ID" |
        curl -sf --connect-timeout 3 --max-time 10 -X POST -H "Content-Type: application/json" \
            -d '{}' -K - "${base%/}/api/github/installation-token" 2>/dev/null) || return 1
    token=$(printf '%s' "$body" | jq -r '.token // empty' 2>/dev/null) || return 1
    expires_at=$(printf '%s' "$body" | jq -r '.expiresAt // empty' 2>/dev/null) || return 1
    [ -n "$token" ] && [ -n "$expires_at" ] || return 1
    expires=$(date -d "$expires_at" +%s 2>/dev/null) || return 1
    if (umask 077; mkdir -p "$cache_dir") 2>/dev/null && cache_usable; then
        local tmp="${cache_file}.$$"
        (umask 077; printf '%s %s\n' "$expires" "$token" > "$tmp") && mv -f "$tmp" "$cache_file"
    fi
    printf '%s' "$token"
}

app_token() {
    read_cache || fetch_app_token
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
            # git rejected the credential: drop the cache so the next get mints a fresh token.
            erase) cache_usable && rm -f "$cache_file" ;;
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
