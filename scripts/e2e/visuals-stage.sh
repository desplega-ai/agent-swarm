#!/bin/bash
# Filter a downloaded Slack visuals artifact down to an explicit allowlist and stage it, flat by
# profile (same shape as the raw artifact), for the next job to consume. No git operations here
# on purpose: this script runs in the unprivileged validation job (no `contents: write`), which
# only ever touches fork-controlled artifact bytes with a token that cannot push or comment. The
# privileged publish job downloads this script's OUTPUT as a same-run artifact instead of the
# raw fork artifact — see slack-visuals-publish.yml for why that split is the point.
#
# $out_root is the extracted contents of a fork-controlled artifact (the E2E job that produced
# it runs with the PR-branch copy of slack-visuals.yml for a fork PR). What gets staged — and
# later published to ci-visuals, served from raw.githubusercontent.com under this repository's
# name — is an explicit allowlist, not "whatever the artifact contains": per-profile only
# index.json, channel.png, and frames/*.{png,gif}, no symlinks, no directory or file names
# outside a safe charset, and a size cap per file.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <out-root> <staged-root>" >&2
  exit 1
fi

out_root=$1
staged_root=$2

if [ ! -d "$out_root" ]; then
  echo "Output root does not exist: $out_root" >&2
  exit 1
fi
out_root=$(cd "$out_root" && pwd -P)

target="$staged_root"
mkdir -p "$staged_root"

profile_name_re='^[A-Za-z0-9_-]+$'
frame_name_re='^[A-Za-z0-9][A-Za-z0-9_.-]*\.(png|gif)$'
frame_dir_re='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
max_json_bytes=$((2 * 1024 * 1024))
max_image_bytes=$((20 * 1024 * 1024))
# Renderer output is <profile>/frames/<scenario>/<thread>/<file>.{png,gif} — two directory
# segments below frames/, then the leaf file. Bound the walk instead of recursing unlimited so a
# crafted artifact can't force an unbounded find.
max_frame_depth=3

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
  # A profile whose E2E run or render failed has no index.json; stage the others.
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

  frames_root=$(cd "$source_dir/frames" && pwd -P)
  staged_count=0
  while IFS= read -r -d '' frame_file; do
    # Path relative to frames_root, e.g. "slack-mention/mention/final-thread.png".
    rel_path=${frame_file#"$frames_root"/}
    frame_name=$(basename "$frame_file")

    if [ -L "$frame_file" ] || [ ! -f "$frame_file" ]; then
      echo "Skipping unsafe frame entry: $frame_file" >&2
      continue
    fi

    # Reject any ".." segment or an absolute-looking rel_path outright — belt and suspenders on
    # top of the segment-charset check below, since a ".." would also fail that charset.
    case "/$rel_path/" in
      */../*|/../*)
        echo "Skipping frame with unsafe path: $rel_path" >&2
        continue
        ;;
    esac

    # Validate every intermediate directory segment: safe charset, and not a symlink (checked by
    # walking from frames_root down to the file's parent — find -L wouldn't traverse a symlinked
    # intermediate dir at all, but validate explicitly so this doesn't silently depend on that).
    rel_dir=$(dirname "$rel_path")
    unsafe_segment=""
    if [ "$rel_dir" != "." ]; then
      walk="$frames_root"
      IFS='/' read -r -a segments <<< "$rel_dir"
      for segment in "${segments[@]}"; do
        if ! [[ "$segment" =~ $frame_dir_re ]]; then
          unsafe_segment=1
          break
        fi
        walk="$walk/$segment"
        if [ -L "$walk" ]; then
          unsafe_segment=1
          break
        fi
      done
    fi
    if [ -n "$unsafe_segment" ]; then
      echo "Skipping frame with unsafe directory segment: $rel_path" >&2
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

    mkdir -p "$target/$profile/frames/$rel_dir"
    cp "$frame_file" "$target/$profile/frames/$rel_path"
    staged_count=$((staged_count + 1))
  done < <(find "$frames_root" -mindepth 1 -maxdepth "$max_frame_depth" -type f -print0)

  if [ "$staged_count" -eq 0 ]; then
    echo "Staged zero frames for $profile (frames dir present but empty or all entries rejected): $source_dir/frames" >&2
    exit 1
  fi
done

if [ ! -d "$target" ]; then
  echo "No profile with an index.json found in $out_root" >&2
  exit 1
fi

echo "Staged at $target" >&2
