#!/usr/bin/env bash
set -euo pipefail

# Code Maat + D3 recurring code-health report template.
#
# Lead kickoff prompt:
#   See ./lead-prompt.md in this template. It is the canonical copy-paste prompt
#   for asking an agent-swarm Lead to install this runner, run it once, publish a
#   stable page, and schedule weekly refreshes.
#
# Default weekly cadence for the surrounding swarm schedule:
#   cron: "0 21 * * 0"
#   timezone: "UTC"
# Change the cron field to adjust when the report refreshes. Keep the same page
# ID when publishing so the report URL stays stable.
#
# Code Maat license note:
#   Code Maat is GPLv3. This template does not vendor or redistribute the JAR.
#   It downloads the upstream standalone JAR at runtime on first run.

BASE_DIR="${BASE_DIR:-/workspace/code-maat}"
REPO_NAME="${REPO_NAME:-my-repo}"
REPO_URL="${REPO_URL:-https://github.com/OWNER/REPO.git}"
BRANCH="${BRANCH:-main}"
SCOPE_PATH="${SCOPE_PATH:-src}"
LOCAL_SOURCE="${LOCAL_SOURCE:-}"

REPO_DIR="$BASE_DIR/repos/$REPO_NAME"
OUT_ROOT="$BASE_DIR/out/$REPO_NAME"
RUN_DATE="${RUN_DATE:-$(date -u +%F)}"
OUT_DIR="$OUT_ROOT/$RUN_DATE"
JAR="$BASE_DIR/code-maat.jar"
CODE_MAAT_URL="${CODE_MAAT_URL:-https://github.com/adamtornhill/code-maat/releases/download/v1.0.4/code-maat-1.0.4-standalone.jar}"

mkdir -p "$BASE_DIR/repos" "$OUT_DIR"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_java() {
  if ! need_cmd java; then
    sudo apt-get update
    sudo apt-get install -y default-jre-headless
  fi
}

ensure_node() {
  if ! need_cmd node; then
    sudo apt-get update
    sudo apt-get install -y nodejs
  fi
}

ensure_python() {
  if ! need_cmd python3; then
    sudo apt-get update
    sudo apt-get install -y python3 python3-pip
  fi
}

ensure_lizard() {
  ensure_python
  if ! need_cmd lizard && [ ! -x "$HOME/.local/bin/lizard" ]; then
    python3 -m pip install --break-system-packages --user lizard
  fi
}

ensure_code_maat() {
  if [ ! -s "$JAR" ]; then
    curl -fsSL -o "$JAR" "$CODE_MAAT_URL"
  fi
  java -jar "$JAR" --help >/dev/null
}

prepare_repo() {
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" remote set-url --push origin DISABLED >/dev/null 2>&1 || true
    git -C "$REPO_DIR" fetch origin "$BRANCH" --prune
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
    git -C "$REPO_DIR" checkout -q "$BRANCH" || git -C "$REPO_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
    git -C "$REPO_DIR" reset --hard "origin/$BRANCH" >/dev/null
  else
    git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    git -C "$REPO_DIR" remote set-url --push origin DISABLED || true
  fi
}

run_code_maat() {
  local analysis="$1"
  shift || true
  java -jar "$JAR" -l "$OUT_DIR/git-src.log" -c git2 -a "$analysis" "$@" -o "$OUT_DIR/$analysis.csv"
}

ensure_java
ensure_node
ensure_lizard
ensure_code_maat
prepare_repo

git -C "$REPO_DIR" log --all --numstat --date=short --pretty=format:'--%h--%ad--%aN' --no-renames -- "$SCOPE_PATH" > "$OUT_DIR/git-src.log"
git -C "$REPO_DIR" rev-parse HEAD > "$OUT_DIR/revision.txt"
git -C "$REPO_DIR" log -1 --format='%h %ad %an %s' --date=short > "$OUT_DIR/revision-summary.txt"
git -C "$REPO_DIR" ls-files "$SCOPE_PATH/**" > "$OUT_DIR/src-files.txt"

run_code_maat summary
run_code_maat revisions -r 10000 -n 1
run_code_maat coupling -r 10000 -m 2 -i 1 -s 60
run_code_maat age -r 10000 -d "$RUN_DATE"
run_code_maat authors -r 10000
run_code_maat entity-ownership -r 10000
run_code_maat entity-effort -r 10000
run_code_maat main-dev -r 10000
run_code_maat main-dev-by-revs -r 10000
run_code_maat abs-churn -r 10000
run_code_maat author-churn -r 10000
run_code_maat entity-churn -r 10000

LIZARD_BIN="$(command -v lizard || true)"
if [ -z "$LIZARD_BIN" ] && [ -x "$HOME/.local/bin/lizard" ]; then
  LIZARD_BIN="$HOME/.local/bin/lizard"
fi
"$LIZARD_BIN" --csv "$REPO_DIR/$SCOPE_PATH" > "$OUT_DIR/lizard-functions.csv" || true

node "$BASE_DIR/report.mjs" "$OUT_DIR" "$REPO_DIR" "$REPO_NAME" "$RUN_DATE" "$SCOPE_PATH"

cp "$OUT_DIR/summary.json" "$OUT_ROOT/latest.json"
cp "$OUT_DIR/report.html" "$OUT_ROOT/latest.html"
cp "$OUT_DIR/latest-pointer.json" "$OUT_ROOT/latest-pointer.json"

echo "Wrote $OUT_DIR"
echo "Latest summary: $OUT_ROOT/latest.json"
echo "Latest page HTML: $OUT_ROOT/latest.html"
