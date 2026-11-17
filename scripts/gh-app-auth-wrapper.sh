#!/usr/bin/env bash
# gh wrapper for GitHub App worker auth. The entrypoint puts its directory first
# on PATH only when the API mints installation tokens. Each call hands the real gh
# a current token from swarm-github-token; on GHES gh reads
# GH_ENTERPRISE_TOKEN, on github.com GH_TOKEN. Without a token, gh runs as before.
#
# The repository the call acts on is passed to the helper, so the API mints for
# that repository's installation. Without a repo the helper mints for the
# deployment-wide GITHUB_APP_INSTALLATION_ID, as before.
real_gh="${SWARM_REAL_GH:-/usr/bin/gh}"

# Precedence follows gh: an explicit --repo/-R wins, then the repo a `gh api`
# path names (GH_REPO only fills its {owner}/{repo} placeholders), then GH_REPO,
# then the origin remote of the current checkout.
repo=""
prev=""
for arg in "$@"; do
    [ "$arg" = "--" ] && break
    case "$prev" in --repo|-R) repo="$arg"; break;; esac
    case "$arg" in
        --repo=*) repo="${arg#--repo=}"; break;;
        -R?*) repo="${arg#-R}"; repo="${repo#=}"; break;;
    esac
    prev="$arg"
done
# `gh api repos/<owner>/<repo>/...` names the repo in its first path argument.
if [ -z "$repo" ] && [ "${1:-}" = "api" ]; then
    for arg in "$@"; do
        case "${arg#/}" in
            repos/*/*)
                repo=$(printf '%s' "${arg#/}" | sed -n 's#^repos/\([^/?]*/[^/?]*\).*#\1#p')
                [ -n "$repo" ] && break
                ;;
        esac
    done
fi
[ -n "$repo" ] || repo="${GH_REPO:-}"
# Otherwise the repo gh runs in, from its origin remote. The API mints for a
# repo's own installation only when an operator listed its owner and the repo is
# registered; any other repo gets the deployment-wide installation.
if [ -z "$repo" ]; then
    repo=$(git remote get-url origin 2>/dev/null |
        sed -n 's#^.*[:/]\([^/:]*/[^/:]*\)$#\1#p' | sed 's/\.git$//')
fi
# gh accepts [HOST/]OWNER/REPO and URLs: keep the last two path segments.
case "$repo" in
    */*/*) repo=$(printf '%s' "$repo" | sed 's#/*$##; s#\.git$##' | sed -n 's#^.*/\([^/]*/[^/]*\)$#\1#p') ;;
esac

if token=$(SWARM_GITHUB_TOKEN_REPO="$repo" "${SWARM_GITHUB_TOKEN_BIN:-/usr/local/bin/swarm-github-token}" 2>/dev/null) && [ -n "$token" ]; then
    if [ -n "${GH_HOST:-}" ] && [ "$GH_HOST" != "github.com" ]; then
        export GH_ENTERPRISE_TOKEN="$token"
    else
        export GH_TOKEN="$token"
    fi
fi
exec "$real_gh" "$@"
