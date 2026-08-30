#!/usr/bin/env bash
# Safely bring local main refs under caller-supplied roots up to origin/main.
# This intentionally never checks out, resets, stashes, cleans, or writes a
# non-main branch. One JSON document is written to stdout for every root.
set -uo pipefail

json_string() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

receipt() {
  local root=$1 status=$2 repos=$3
  printf '{"root":%s,"status":%s,"repos":[%s]}\n' \
    "$(printf '%s' "$root" | json_string)" \
    "$(printf '%s' "$status" | json_string)" "$repos"
}

repo_receipt() {
  local path=$1 status=$2 reason=$3 local_main=${4:-null} origin_main=${5:-null}
  printf '{"path":%s,"status":%s,"reason":%s,"localMain":%s,"originMain":%s}' \
    "$(printf '%s' "$path" | json_string)" \
    "$(printf '%s' "$status" | json_string)" \
    "$(printf '%s' "$reason" | json_string)" "$local_main" "$origin_main"
}

if (( $# == 0 )); then
  echo 'usage: sync-main-checkouts.sh ROOT [ROOT...]' >&2
  exit 64
fi

aggregate=0
for requested_root in "$@"; do
  repos=()
  root_status=green

  if [[ ! -d "$requested_root" || -L "$requested_root" ]]; then
    receipt "$requested_root" error "$(repo_receipt "$requested_root" error "root-missing-or-symlink")"
    aggregate=1
    continue
  fi

  # A root-local atomic mkdir lock prevents two coordinators from manipulating
  # the same refs concurrently. It is deliberately not a git lock because one
  # run covers many independent repositories.
  lock="$requested_root/.nightly-main-sync.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    receipt "$requested_root" unsafe "$(repo_receipt "$requested_root" unsafe "overlap-lock-held")"
    aggregate=1
    continue
  fi

  while IFS= read -r -d '' entry; do
    [[ "$entry" == "$lock" ]] && continue
    if [[ -L "$entry" ]]; then
      repos+=("$(repo_receipt "$entry" skipped "symlink-not-followed")")
      continue
    fi
    if ! git -C "$entry" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      repos+=("$(repo_receipt "$entry" skipped "not-a-git-worktree")")
      continue
    fi
    top=$(git -C "$entry" rev-parse --show-toplevel 2>/dev/null || true)
    # Do not let a nested directory point the command at a repository outside
    # the requested root's immediate child boundary.
    if [[ -z "$top" || "$(readlink -f "$top")" != "$(readlink -f "$entry")" ]]; then
      repos+=("$(repo_receipt "$entry" skipped "not-a-checkout-root")")
      continue
    fi
    if ! git -C "$entry" config --get remote.origin.url >/dev/null 2>&1; then
      repos+=("$(repo_receipt "$entry" unsafe "missing-origin")")
      root_status=unsafe; aggregate=1
      continue
    fi
    if ! git -C "$entry" fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main >/dev/null 2>&1; then
      repos+=("$(repo_receipt "$entry" failed "fetch-origin-main-failed")")
      root_status=failed; aggregate=1
      continue
    fi
    if ! origin=$(git -C "$entry" rev-parse --verify refs/remotes/origin/main 2>/dev/null); then
      repos+=("$(repo_receipt "$entry" unsafe "missing-origin-main")")
      root_status=unsafe; aggregate=1
      continue
    fi
    if ! local_main=$(git -C "$entry" rev-parse --verify refs/heads/main 2>/dev/null); then
      repos+=("$(repo_receipt "$entry" unsafe "missing-local-main" null "\"$origin\"")")
      root_status=unsafe; aggregate=1
      continue
    fi
    if ! git -C "$entry" merge-base --is-ancestor "$local_main" "$origin" >/dev/null 2>&1; then
      repos+=("$(repo_receipt "$entry" unsafe "local-main-diverged" "\"$local_main\"" "\"$origin\"")")
      root_status=unsafe; aggregate=1
      continue
    fi

    branch=$(git -C "$entry" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    if [[ "$branch" == main ]]; then
      if [[ -n $(git -C "$entry" status --porcelain) ]]; then
        repos+=("$(repo_receipt "$entry" unsafe "checked-out-main-dirty" "\"$local_main\"" "\"$origin\"")")
        root_status=unsafe; aggregate=1
        continue
      fi
      if ! git -C "$entry" merge --ff-only refs/remotes/origin/main >/dev/null 2>&1; then
        repos+=("$(repo_receipt "$entry" failed "fast-forward-main-failed" "\"$local_main\"" "\"$origin\"")")
        root_status=failed; aggregate=1
        continue
      fi
      repos+=("$(repo_receipt "$entry" green "checked-out-main-fast-forwarded" "\"$(git -C "$entry" rev-parse refs/heads/main)\"" "\"$origin\"")")
    else
      # update-ref's expected-old argument makes the ref write atomic. The
      # preceding ancestry check means this can only be a fast-forward.
      if ! git -C "$entry" update-ref refs/heads/main "$origin" "$local_main"; then
        repos+=("$(repo_receipt "$entry" failed "main-ref-changed-during-sync" "\"$local_main\"" "\"$origin\"")")
        root_status=failed; aggregate=1
        continue
      fi
      repos+=("$(repo_receipt "$entry" green "main-ref-fast-forwarded-off-branch" "\"$origin\"" "\"$origin\"")")
    fi
  done < <(find -P "$requested_root" -mindepth 1 -maxdepth 1 -print0)

  joined=$(IFS=,; printf '%s' "${repos[*]:-}")
  receipt "$requested_root" "$root_status" "$joined"
  rmdir "$lock" 2>/dev/null || { echo "failed to remove overlap lock: $lock" >&2; aggregate=1; }
done

exit "$aggregate"
