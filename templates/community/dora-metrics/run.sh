#!/usr/bin/env bash
set -euo pipefail

# DORA metrics recurring report template.
#
# Lead kickoff prompt:
#   See ./lead-prompt.md in this template. It is the canonical copy-paste prompt
#   for asking an agent-swarm Lead to install this runner, run it once, publish a
#   stable page, and schedule weekly refreshes.
#
# Default weekly cadence for the surrounding swarm schedule:
#   cron: "0 22 * * 0"
#   timezone: "UTC"
# Change the cron field to adjust when the report refreshes. Keep the same page
# ID when publishing so the report URL stays stable.
#
# Data-source note:
#   Deployment Frequency and Lead Time for Changes are exact for repositories
#   where v* tags map 1:1 to production releases. Change Failure Rate and Failed
#   Deployment Recovery Time are proxy estimates from revert/hotfix signals.

BASE_DIR="${BASE_DIR:-/workspace/dora-metrics}"
REPO_NAME="${REPO_NAME:-my-repo}"
REPO_URL="${REPO_URL:-https://github.com/OWNER/REPO.git}"
BRANCH="${BRANCH:-main}"
LOCAL_SOURCE="${LOCAL_SOURCE:-}"
WINDOW_DAYS="${WINDOW_DAYS:-90}"
HOTFIX_WINDOW_HOURS="${HOTFIX_WINDOW_HOURS:-24}"
TAG_PATTERN="${TAG_PATTERN:-v*}"

REPO_DIR="$BASE_DIR/repos/$REPO_NAME"
OUT_ROOT="$BASE_DIR/out/$REPO_NAME"
RUN_DATE="${RUN_DATE:-$(date -u +%F)}"
OUT_DIR="$OUT_ROOT/$RUN_DATE"

mkdir -p "$BASE_DIR/repos" "$OUT_DIR"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

apt_install() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Missing $*: install it in the worker image or run this setup as root before the agent drops privileges." >&2
    exit 1
  fi
  apt-get update
  apt-get install -y "$@"
}

ensure_cmd() {
  local cmd="$1"
  local pkg="${2:-$1}"
  if ! need_cmd "$cmd"; then
    apt_install "$pkg"
  fi
}

prepare_repo() {
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" remote set-url --push origin DISABLED >/dev/null 2>&1 || true
    git -C "$REPO_DIR" fetch origin "$BRANCH" --prune
    git -C "$REPO_DIR" fetch origin "refs/tags/$TAG_PATTERN:refs/tags/$TAG_PATTERN" --prune --force || true
    git -C "$REPO_DIR" checkout -q "$BRANCH" || git -C "$REPO_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
    git -C "$REPO_DIR" reset --hard "origin/$BRANCH" >/dev/null
    git -C "$REPO_DIR" clean -fdx >/dev/null
    return
  fi

  if [ -n "$LOCAL_SOURCE" ] && [ -d "$LOCAL_SOURCE/.git" ]; then
    git clone --no-hardlinks "$LOCAL_SOURCE" "$REPO_DIR"
    git -C "$REPO_DIR" remote set-url origin "$REPO_URL" || true
    git -C "$REPO_DIR" remote set-url --push origin DISABLED || true
    git -C "$REPO_DIR" fetch origin "$BRANCH" --prune
    git -C "$REPO_DIR" fetch origin "refs/tags/$TAG_PATTERN:refs/tags/$TAG_PATTERN" --prune --force || true
    git -C "$REPO_DIR" checkout -q "$BRANCH" || git -C "$REPO_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
    git -C "$REPO_DIR" reset --hard "origin/$BRANCH" >/dev/null
  else
    git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    git -C "$REPO_DIR" remote set-url --push origin DISABLED || true
    git -C "$REPO_DIR" fetch origin "refs/tags/$TAG_PATTERN:refs/tags/$TAG_PATTERN" --prune --force || true
  fi
}

write_pr_metadata() {
  local slug
  slug="$(printf '%s\n' "$REPO_URL" | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
  if need_cmd gh && gh auth status >/dev/null 2>&1 && printf '%s\n' "$slug" | grep -Eq '^[^/]+/[^/]+$'; then
    gh pr list \
      --repo "$slug" \
      --state merged \
      --base "$BRANCH" \
      --limit 1000 \
      --json number,title,mergedAt,url,author,headRefName \
      > "$OUT_DIR/prs.json" || printf '[]\n' > "$OUT_DIR/prs.json"
  else
    printf '[]\n' > "$OUT_DIR/prs.json"
  fi
}

ensure_cmd git git
ensure_cmd jq jq
ensure_cmd node nodejs
prepare_repo

git -C "$REPO_DIR" rev-parse HEAD > "$OUT_DIR/revision.txt"
git -C "$REPO_DIR" log -1 --format='%h %ad %an %s' --date=short > "$OUT_DIR/revision-summary.txt"
git -C "$REPO_DIR" for-each-ref "refs/tags/$TAG_PATTERN" --sort=creatordate --format='%(refname:short)%09%(objectname)%09%(creatordate:iso-strict)%09%(creatordate:unix)' > "$OUT_DIR/tags.tsv"
git -C "$REPO_DIR" log "origin/$BRANCH" --since="$WINDOW_DAYS days ago" --format='%H%x09%ct%x09%an%x09%s' > "$OUT_DIR/recent-commits.tsv"
git -C "$REPO_DIR" log "origin/$BRANCH" --since="$WINDOW_DAYS days ago" --grep='revert' --grep='rollback' --grep='hotfix' --grep='fix-forward' --regexp-ignore-case --format='%H%x09%ct%x09%an%x09%s' > "$OUT_DIR/remediation-commits.tsv"
write_pr_metadata

node "$BASE_DIR/report.mjs" "$OUT_DIR" "$REPO_DIR" "$REPO_NAME" "$RUN_DATE" "$BRANCH" "$WINDOW_DAYS" "$HOTFIX_WINDOW_HOURS" "$TAG_PATTERN"

cp "$OUT_DIR/summary.json" "$OUT_ROOT/latest.json"
cp "$OUT_DIR/report.html" "$OUT_ROOT/latest.html"
cp "$OUT_DIR/latest-pointer.json" "$OUT_ROOT/latest-pointer.json"

echo "Wrote $OUT_DIR"
echo "Latest summary: $OUT_ROOT/latest.json"
echo "Latest page HTML: $OUT_ROOT/latest.html"
