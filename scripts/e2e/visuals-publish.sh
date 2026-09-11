#!/bin/bash
# Publish rendered Slack visuals for one PR to the `ci-visuals` branch.
# The branch is rebuilt as a single commit on every run, so history never grows, and
# --force-with-lease guards against a concurrent run from another PR (retry on rejection).
# Prints `base_url=<raw.githubusercontent.com prefix>` on the last line.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <out-root> <pr-number> <head-sha>" >&2
  exit 1
fi

out_root=$1
pr_number=$2
head_sha=$3

# Defense in depth: the caller (slack-visuals-publish.yml) already validates these against
# trusted GitHub API metadata before invoking this script, but this script is directly runnable
# and pr_number/head_sha end up in a git ref path below, so re-validate here too.
if ! [[ "$pr_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "pr-number must be a positive decimal integer: $pr_number" >&2
  exit 1
fi
if ! [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "head-sha must be exactly 40 lowercase hex characters: $head_sha" >&2
  exit 1
fi
sha7=${head_sha:0:7}

if [ ! -d "$out_root" ]; then
  echo "Output root does not exist: $out_root" >&2
  exit 1
fi
out_root=$(cd "$out_root" && pwd -P)

repository=${GITHUB_REPOSITORY:-}
if [ -z "$repository" ]; then
  remote_url=$(git remote get-url origin)
  case "$remote_url" in
    git@github.com:*) repository=${remote_url#git@github.com:} ;;
    https://github.com/*) repository=${remote_url#https://github.com/} ;;
    ssh://git@github.com/*) repository=${remote_url#ssh://git@github.com/} ;;
    *)
      echo "Cannot derive GitHub repository from origin: $remote_url" >&2
      exit 1
      ;;
  esac
  repository=${repository%.git}
fi

if [[ "$repository" != */* ]]; then
  echo "GITHUB_REPOSITORY must be owner/repo: $repository" >&2
  exit 1
fi

worktree_dir=""

cleanup() {
  if [ -n "$worktree_dir" ]; then
    git worktree remove --force "$worktree_dir" >/dev/null 2>&1 || rm -rf "$worktree_dir"
    worktree_dir=""
  fi
  git branch -D ci-visuals-build >/dev/null 2>&1 || true
}

trap cleanup EXIT

for attempt in 1 2 3; do
  fetched_sha=""
  if git fetch origin ci-visuals; then
    fetched_sha=$(git rev-parse FETCH_HEAD)
  fi

  worktree_dir=$(mktemp -d)
  rmdir "$worktree_dir"
  git worktree add --detach "$worktree_dir"
  (
    cd "$worktree_dir"
    git checkout --orphan ci-visuals-build
    git rm -rf . >/dev/null 2>&1 || true
    git clean -fdx >/dev/null
    if [ -n "$fetched_sha" ]; then
      git checkout "$fetched_sha" -- .
    fi

    target="pr-$pr_number/$sha7"
    rm -rf "pr-$pr_number"

    # $out_root is the extracted contents of a fork-controlled artifact (the E2E job that
    # produced it runs with the PR-branch copy of slack-visuals.yml for a fork PR). What gets
    # published to ci-visuals — and served from raw.githubusercontent.com under this
    # repository's name — is an explicit allowlist, not "whatever the artifact contains":
    # per-profile only index.json, channel.png, and frames/*.{png,gif}, no symlinks, no
    # directory names or filenames outside a safe charset, and a size cap per file.
    profile_name_re='^[A-Za-z0-9_-]+$'
    frame_name_re='^[A-Za-z0-9][A-Za-z0-9_.-]*\.(png|gif)$'
    max_json_bytes=$((2 * 1024 * 1024))
    max_image_bytes=$((20 * 1024 * 1024))

    file_size() {
      stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
    }

    for source_dir in "$out_root"/*; do
      [ -d "$source_dir" ] || continue
      [ -L "$source_dir" ] && { echo "Skipping symlinked profile dir: $source_dir" >&2; continue; }
      profile=$(basename "$source_dir")
      if ! [[ "$profile" =~ $profile_name_re ]]; then
        echo "Rejecting profile with unsafe name: $profile" >&2
        exit 1
      fi
      # A profile whose E2E run or render failed has no index.json; publish the others.
      if [ ! -f "$source_dir/index.json" ] || [ -L "$source_dir/index.json" ]; then
        echo "Skipping $profile: no index.json in $source_dir" >&2
        continue
      fi
      if [ "$(file_size "$source_dir/index.json")" -gt "$max_json_bytes" ]; then
        echo "Rejecting $profile: index.json exceeds $max_json_bytes bytes" >&2
        exit 1
      fi
      if [ ! -f "$source_dir/channel.png" ] || [ -L "$source_dir/channel.png" ]; then
        echo "Missing channel.png in $source_dir" >&2
        exit 1
      fi
      if [ "$(file_size "$source_dir/channel.png")" -gt "$max_image_bytes" ]; then
        echo "Rejecting $profile: channel.png exceeds $max_image_bytes bytes" >&2
        exit 1
      fi
      if [ ! -d "$source_dir/frames" ] || [ -L "$source_dir/frames" ]; then
        echo "Missing frames directory in $source_dir" >&2
        exit 1
      fi

      mkdir -p "$target/$profile/frames"
      cp "$source_dir/index.json" "$target/$profile/"
      cp "$source_dir/channel.png" "$target/$profile/"
      while IFS= read -r -d '' frame_file; do
        frame_name=$(basename "$frame_file")
        if [ -L "$frame_file" ] || [ ! -f "$frame_file" ]; then
          echo "Skipping unsafe frame entry: $frame_file" >&2
          continue
        fi
        if ! [[ "$frame_name" =~ $frame_name_re ]]; then
          echo "Skipping frame with unsafe name: $frame_name" >&2
          continue
        fi
        if [ "$(file_size "$frame_file")" -gt "$max_image_bytes" ]; then
          echo "Skipping oversized frame: $frame_name" >&2
          continue
        fi
        cp "$frame_file" "$target/$profile/frames/$frame_name"
      done < <(find "$source_dir/frames" -mindepth 1 -maxdepth 1 -print0)
    done
    if [ ! -d "$target" ]; then
      echo "No profile with an index.json found in $out_root" >&2
      exit 1
    fi
    date -u +%FT%TZ > "pr-$pr_number/updated-at"

    now=$(date -u +%s)
    for pr_dir in pr-*; do
      [ -d "$pr_dir" ] || continue
      [ -f "$pr_dir/updated-at" ] || continue
      updated_at=$(<"$pr_dir/updated-at")
      if updated_seconds=$(date --date "$updated_at" +%s 2>/dev/null); then
        :
      elif updated_seconds=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$updated_at" +%s 2>/dev/null); then
        :
      else
        continue
      fi
      if [ $((now - updated_seconds)) -gt $((30 * 24 * 60 * 60)) ]; then
        rm -rf "$pr_dir"
      fi
    done

    # Vercel deploys every ci-visuals push, which fails ROOTDIR_NOT_EXIST.
    # Root-directory resolution precedes the Ignored Build Step, so disable
    # deployments at both the repo root and each Vercel project root instead.
    for vercel_root in . apps/ui apps/templates-ui docs-site; do
      mkdir -p "$vercel_root"
      cat > "$vercel_root/vercel.json" <<'JSON'
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": { "deploymentEnabled": { "ci-visuals": false } }
}
JSON
    done

    git add -A
    git -c user.name='github-actions[bot]' \
      -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      commit --allow-empty -m "visuals: pr-$pr_number $sha7"
  )

  if git -C "$worktree_dir" push --force-with-lease="refs/heads/ci-visuals:$fetched_sha" origin HEAD:refs/heads/ci-visuals; then
    cleanup
    echo "base_url=https://raw.githubusercontent.com/$repository/ci-visuals/pr-$pr_number/$sha7"
    exit 0
  fi

  echo "Push rejected on attempt $attempt of 3. Retrying." >&2
  cleanup
done

echo "Could not publish ci-visuals after 3 attempts." >&2
exit 1
