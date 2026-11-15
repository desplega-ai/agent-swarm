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

repo="${GH_REPO:-}"
if [ -z "$repo" ]; then
    prev=""
    for arg in "$@"; do
        case "$prev" in --repo|-R) repo="$arg"; break;; esac
        case "$arg" in --repo=*|-R=*) repo="${arg#*=}"; break;; esac
        prev="$arg"
    done
fi
# `gh api repos/<owner>/<repo>/...` names the repo in its first path argument.
if [ -z "$repo" ]; then
    for arg in "$@"; do
        case "${arg#/}" in
            repos/*/*)
                repo=$(printf '%s' "${arg#/}" | sed -n 's#^repos/\([^/]*/[^/]*\).*#\1#p')
                [ -n "$repo" ] && break
                ;;
        esac
    done
fi
# Otherwise the repo gh runs in, from its origin remote. A remote that is not
# the swarm's GitHub host still yields owner/name; the API refuses it unless the
# repo is registered, and the helper falls back to the PAT.
if [ -z "$repo" ]; then
    repo=$(git remote get-url origin 2>/dev/null |
        sed -n 's#^.*[:/]\([^/:]*/[^/:]*\)$#\1#p' | sed 's/\.git$//')
fi

if token=$(SWARM_GITHUB_TOKEN_REPO="$repo" "${SWARM_GITHUB_TOKEN_BIN:-/usr/local/bin/swarm-github-token}" 2>/dev/null) && [ -n "$token" ]; then
    if [ -n "${GH_HOST:-}" ] && [ "$GH_HOST" != "github.com" ]; then
        export GH_ENTERPRISE_TOKEN="$token"
    else
        export GH_TOKEN="$token"
    fi
fi
exec "$real_gh" "$@"
