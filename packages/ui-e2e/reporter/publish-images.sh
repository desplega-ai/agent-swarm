#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: publish-images.sh <results-dir> <agent-fs-prefix> [cap]" >&2
  exit 2
fi

results_dir=$1
prefix=$2
cap=${3:-24}
printf '[]\n' > images.json

if [ ! -d "$results_dir" ]; then
  echo "Results directory does not exist: $results_dir" >&2
  exit 2
fi
if ! [[ "$cap" =~ ^[0-9]+$ ]]; then
  echo "Cap must be a non-negative integer" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is unavailable. Skipping image upload."
  exit 0
fi
if ! command -v agent-fs >/dev/null 2>&1; then
  echo "agent-fs is unavailable. Skipping image upload."
  exit 0
fi

required_env=(
  AGENT_FS_API_URL
  AGENT_FS_API_KEY
  AGENT_FS_DEFAULT_ORG_ID
  AGENT_FS_DEFAULT_DRIVE_ID
)
for name in "${required_env[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "$name is unavailable. Skipping image upload."
    exit 0
  fi
done
if ! agent-fs auth whoami >/dev/null 2>&1; then
  echo "agent-fs authentication failed. Skipping image upload."
  exit 0
fi

temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
raw_results="$temp_dir/results.jsonl"
ordered_screenshots="$temp_dir/screenshots.jsonl"
: > "$raw_results"

while IFS= read -r summary; do
  if ! jq -c --arg summaryDir "$(dirname "$summary")" \
    '.results[]? + { _summaryDir: $summaryDir }' "$summary" >> "$raw_results"; then
    echo "Could not read $summary. Skipping it." >&2
  fi
done < <(find "$results_dir" -type f -name summary.json | sort)

jq -sc '
  to_entries
  | map(.value + { _order: .key })
  | ((map(select(.status == "failed" or .status == "timedOut")) | sort_by(._order))
    + (map(select(.status == "passed" and (.file | endswith("specs/smoke.spec.ts"))))
      | sort_by([._summaryDir, ._order])))
  | .[]
  | . as $result
  | ($result.screenshots // [])[]?
  | {
      name: $result.title,
      status: $result.status,
      path: .path,
      summaryDir: $result._summaryDir
    }
' "$raw_results" > "$ordered_screenshots"

resolve_screenshot() {
  local screenshot_path=$1
  local summary_dir=$2
  local suffix candidate
  if [ -f "$screenshot_path" ]; then
    printf '%s\n' "$screenshot_path"
    return 0
  fi
  if [[ "$screenshot_path" == *"/test-results/"* ]]; then
    suffix=${screenshot_path#*/test-results/}
    candidate="$summary_dir/$suffix"
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  suffix=${screenshot_path#test-results/}
  candidate="$summary_dir/$suffix"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

count=0
while IFS= read -r candidate; do
  if [ "$count" -ge "$cap" ]; then break; fi
  name=$(jq -r '.name' <<< "$candidate")
  screenshot_path=$(jq -r '.path' <<< "$candidate")
  summary_dir=$(jq -r '.summaryDir' <<< "$candidate")
  if ! local_path=$(resolve_screenshot "$screenshot_path" "$summary_dir"); then
    echo "Screenshot is missing for $name. Skipping it." >&2
    continue
  fi

  slug=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/-\{1,\}/-/g; s/^-//; s/-$//')
  if [ -z "$slug" ]; then slug=screenshot; fi
  count=$((count + 1))
  remote_path="$prefix/$slug-$count.png"
  if ! agent-fs write "$remote_path" --file "$local_path" -m "ui-e2e ${GITHUB_SHA:-unknown}" >/dev/null 2>&1; then
    echo "Upload failed for $name. Continuing." >&2
    continue
  fi
  if ! signed_output=$(agent-fs signed-url "$remote_path" --json --expires-in 604800 2>/dev/null); then
    echo "Signed URL creation failed for $name. Continuing." >&2
    continue
  fi
  if ! entry=$(jq -c --arg name "$name" \
    'select(.kind == "presigned") | { name: $name, url: .url, expiresAt: .expiresAt }' \
    <<< "$signed_output"); then
    echo "Invalid signed URL response for $name. Continuing." >&2
    continue
  fi
  if [ -z "$entry" ]; then
    echo "No presigned URL was returned for $name. Continuing." >&2
    continue
  fi
  jq --argjson entry "$entry" '. + [$entry]' images.json > "$temp_dir/images.json"
  mv "$temp_dir/images.json" images.json
done < "$ordered_screenshots"

echo "Published $(jq length images.json) UI E2E images."
