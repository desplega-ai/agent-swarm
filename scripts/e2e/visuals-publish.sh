#!/bin/bash
# Publish an already-staged, allowlist-filtered Slack visuals tree (flat by profile, e.g.
# <staged-root>/legacy, <staged-root>/v2) for one PR to agent-fs, then share that folder as a
# public, non-expiring site so the sticky PR comment can embed the images. Staging (filtering
# fork-controlled artifact contents down to an explicit allowlist) happens earlier, in the
# unprivileged validation job — see visuals-stage.sh and slack-visuals-publish.yml for why that
# split exists. This script only uploads input it treats as already-safe.
#
# The images used to live on a `ci-visuals` git branch, which grew the repository's history on
# every run. agent-fs keeps them outside the repo: ci-visuals/pr-<N>/<sha7>/<profile>/...
# Needs AGENT_FS_API_URL, AGENT_FS_API_KEY, AGENT_FS_DEFAULT_ORG_ID and AGENT_FS_DEFAULT_DRIVE_ID.
# Prints `base_url=<share site URL>` on the last line.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <staged-root> <pr-number> <head-sha>" >&2
  exit 1
fi

staged_root=$1
pr_number=$2
head_sha=$3

# Defense in depth: the caller already validated these against trusted GitHub API metadata
# before invoking this script, but this script is directly runnable and pr_number/head_sha end
# up in an agent-fs path below, so re-validate here too.
if ! [[ "$pr_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "pr-number must be a positive decimal integer: $pr_number" >&2
  exit 1
fi
if ! [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "head-sha must be exactly 40 lowercase hex characters: $head_sha" >&2
  exit 1
fi
sha7=${head_sha:0:7}

if [ ! -d "$staged_root" ]; then
  echo "Staged directory does not exist: $staged_root" >&2
  exit 1
fi
staged_root=$(cd "$staged_root" && pwd -P)
if [ -z "$(find "$staged_root" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]; then
  echo "No staged profile directories found in $staged_root" >&2
  exit 1
fi

for var in AGENT_FS_API_URL AGENT_FS_API_KEY AGENT_FS_DEFAULT_ORG_ID AGENT_FS_DEFAULT_DRIVE_ID; do
  if [ -z "${!var:-}" ]; then
    echo "$var is not set. Add the E2E_AGENT_FS_* repository secrets." >&2
    exit 1
  fi
done

# shortcut: published folders are never pruned or revoked, add a cleanup job if drive storage matters.
dest="ci-visuals/pr-$pr_number/$sha7"
export dest pr_number sha7

# Only images: the comment embeds PNG/GIF files, and index.json stays out of the public share.
# One retry per file covers a transient API error; 8 uploads at a time keep a big run in budget.
# shellcheck disable=SC2016 # expanded by the inner bash, not here
uploaded=$(cd "$staged_root" && find . -mindepth 2 -type f \( -name '*.png' -o -name '*.gif' \) -print0 \
  | xargs -0 -r -n 1 -P 8 bash -c '
      rel=${1#./}
      for attempt in 1 2; do
        if agent-fs write "$dest/$rel" --file "$1" -m "visuals: pr-$pr_number $sha7" >/dev/null; then
          echo "$rel"
          exit 0
        fi
        echo "Upload attempt $attempt failed: $rel" >&2
      done
      exit 1
    ' _ | wc -l)

if [ "$uploaded" -eq 0 ]; then
  echo "No images uploaded from $staged_root" >&2
  exit 1
fi
echo "Uploaded $uploaded images to $dest" >&2

share_json=$(agent-fs share-create "$dest" --expires-in never --json)
base_url=$(jq -r '.url // empty' <<<"$share_json")
if ! [[ "$base_url" =~ ^https://[^[:space:]\"\<\>]+/$ ]]; then
  echo "share-create returned no usable https site URL: kind=$(jq -r '.kind // "?"' <<<"$share_json")" >&2
  exit 1
fi

echo "base_url=$base_url"
