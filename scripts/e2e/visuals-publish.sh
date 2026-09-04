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
    for source_dir in "$out_root"/*; do
      [ -d "$source_dir" ] || continue
      profile=$(basename "$source_dir")
      # A profile whose E2E run or render failed has no index.json; publish the others.
      if [ ! -f "$source_dir/index.json" ]; then
        echo "Skipping $profile: no index.json in $source_dir" >&2
        continue
      fi
      for required_file in channel.png frames; do
        if [ ! -e "$source_dir/$required_file" ]; then
          echo "Missing $required_file in $source_dir" >&2
          exit 1
        fi
      done
      mkdir -p "$target/$profile"
      cp "$source_dir/index.json" "$target/$profile/"
      cp "$source_dir/channel.png" "$target/$profile/"
      cp -R "$source_dir/frames" "$target/$profile/"
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
