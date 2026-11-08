#!/usr/bin/env bash
# Run by .github/workflows/pr-metrics.yml after "checks" finishes on a pull request: downloads that run's metrics
# artifacts and main's, renders tools/ci/pr-report.mts and creates or updates the PR's one metrics comment.
# Needs GH_TOKEN, REPO, RUN_ID (the PR's checks run), HEAD_SHA (its head commit) and RUN_CREATED (its start time).
# Every downloaded file is data from a PR's run: nothing here executes it.
set -euo pipefail
work=$(mktemp -d)
artifacts=(ci-metrics-test ci-metrics-boot memory-result memory-lowmem-result)

pr=$(gh pr list --repo "$REPO" --state open --limit 200 --json number,headRefOid --jq ".[] | select(.headRefOid == \"$HEAD_SHA\") | .number" | head -1)
if [ -z "$pr" ]; then echo "no open pull request has head $HEAD_SHA (pushed again or closed); nothing to post"; exit 0; fi
base_sha=$(gh pr view "$pr" --repo "$REPO" --json baseRefOid --jq .baseRefOid)

# main's numbers: the checks run on the PR's base commit, else the newest finished main run that started before this one
runs=$(gh run list --repo "$REPO" --workflow ci.yml --branch main --event push --status completed --limit 50 --json databaseId,headSha,createdAt)
base_run=$(jq -r --arg sha "$base_sha" '[.[] | select(.headSha == $sha)][0].databaseId // empty' <<<"$runs")
if [ -z "$base_run" ]; then base_run=$(jq -r --arg t "$RUN_CREATED" '[.[] | select(.createdAt < $t)][0].databaseId // empty' <<<"$runs"); fi
base_used=$(jq -r --arg id "$base_run" '[.[] | select((.databaseId | tostring) == $id)][0].headSha // empty' <<<"$runs")

fetch() { for a in "${artifacts[@]}"; do gh run download "$1" --repo "$REPO" --name "$a" --dir "$2/$a" 2>/dev/null || echo "run $1 has no artifact $a"; done; }
fetch "$RUN_ID" "$work/head"
base_args=()
if [ -n "$base_run" ]; then fetch "$base_run" "$work/base"; base_args=(--base "$work/base" --base-sha "$base_used"); fi
node --experimental-strip-types --no-warnings tools/ci/pr-report.mts --head "$work/head" --head-sha "$HEAD_SHA" "${base_args[@]}" --out "$work/comment.md"
cat "$work/comment.md"

# a newer push has its own run coming; don't overwrite its comment with older numbers
now=$(gh pr view "$pr" --repo "$REPO" --json headRefOid --jq .headRefOid)
if [ "$now" != "$HEAD_SHA" ]; then echo "PR #$pr moved on to $now; not posting numbers for $HEAD_SHA"; exit 0; fi
id=$(gh api "repos/$REPO/issues/$pr/comments" --paginate --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("<!-- kong-pr-metrics -->"))) | .id' | head -1)
if [ -n "$id" ]; then gh api --method PATCH "repos/$REPO/issues/comments/$id" -F "body=@$work/comment.md" > /dev/null; echo "updated comment $id on #$pr"
else gh api "repos/$REPO/issues/$pr/comments" -F "body=@$work/comment.md" > /dev/null; echo "commented on #$pr"; fi
