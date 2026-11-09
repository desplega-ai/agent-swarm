#!/bin/bash
# Confirm that <head-sha> is a head commit of PR <pr-number> in $GITHUB_REPOSITORY, using only
# GitHub API data. Called by the unprivileged `validate` job in slack-visuals-publish.yml with
# the PR number from the (untrusted) artifact and the head sha + head repository from the
# trusted `workflow_run` event, so the artifact's PR claim is accepted only when GitHub itself
# links that commit to that PR.
#
# Why the commit's associated-PRs lookup and not pulls/<pr>: the PR head can legitimately move
# on before this job runs, and comparing against the PR's CURRENT head would false-reject.
#
# Lookup order:
#   1. repos/$GITHUB_REPOSITORY/commits/<sha>/pulls. Matches in-repo PRs.
#   2. Only when (1) has no match and the head repo is a different repo (a fork):
#      repos/<head-repo>/commits/<sha>/pulls. A commit that lives only in a fork returns []
#      from (1), but the fork's lookup lists the upstream PR. That entry must also have
#      base.repo == $GITHUB_REPOSITORY and head.repo == <head-repo>.
# Every accepted entry needs number == <pr-number> and base.repo == $GITHUB_REPOSITORY, and
# exactly one entry must match. Any API error fails closed (set -e).
#
# Prints `source=base` or `source=head-repo` on success. Exits 1 on rejection.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <pr-number> <head-sha> <head-repo-full-name>" >&2
  exit 1
fi

pr_number=$1
head_sha=$2
head_repo=$3
base_repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}

if ! [[ "$pr_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "pr-number must be a positive decimal integer: $pr_number" >&2
  exit 1
fi
if ! [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "head-sha must be exactly 40 lowercase hex characters: $head_sha" >&2
  exit 1
fi
# head_repo goes into an API path, so pin it to owner/name characters.
if ! [[ "$head_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || [[ "$head_repo" =~ (^|/)\.\.?(/|$) ]]; then
  echo "head-repo must be <owner>/<name>: $head_repo" >&2
  exit 1
fi

count_matches() {
  # $1 = JSON array of PRs, $2 = required head repo ("" = any)
  printf '%s' "$1" | jq --argjson pr "$pr_number" --arg base "$base_repo" --arg head "$2" \
    '[.[] | select(.number == $pr and .base.repo.full_name == $base
      and ($head == "" or .head.repo.full_name == $head))] | length'
}

associated=$(gh api "repos/$base_repo/commits/$head_sha/pulls")
match_count=$(count_matches "$associated" "")
if [ "$match_count" -eq 1 ]; then
  echo "source=base"
  exit 0
fi

if [ "$match_count" -eq 0 ] && [ "$head_repo" != "$base_repo" ]; then
  associated=$(gh api "repos/$head_repo/commits/$head_sha/pulls")
  match_count=$(count_matches "$associated" "$head_repo")
  if [ "$match_count" -eq 1 ]; then
    echo "source=head-repo"
    exit 0
  fi
fi

echo "Commit $head_sha is not associated with exactly one PR #$pr_number based in $base_repo (head repo $head_repo, found $match_count)." >&2
exit 1
