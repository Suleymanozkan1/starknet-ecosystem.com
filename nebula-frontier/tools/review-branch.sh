#!/usr/bin/env bash
# Builds a CodeRabbit subsystem-review branch pair from HEAD (OSS plan: max 100 files per PR).
#   base = HEAD tree minus <paths>, parented on merge-base with origin/main
#   head = HEAD tree, parented on base  → PR diff contains only <paths>
# Usage: tools/review-branch.sh <name> <path>...   (paths relative to repo root)
set -euo pipefail
name=$1; shift
cd "$(git rev-parse --show-toplevel)"
H=$(git rev-parse HEAD); MB=$(git merge-base HEAD origin/main)
idx=$(mktemp); trap 'rm -f "$idx"' EXIT
GIT_INDEX_FILE=$idx git read-tree "$H"
GIT_INDEX_FILE=$idx git rm -rq --cached --ignore-unmatch "$@"
T=$(GIT_INDEX_FILE=$idx git write-tree)
B=$(git commit-tree "$T" -p "$MB" -m "Review base: tree without $name paths")
R=$(git commit-tree "$(git rev-parse "$H^{tree}")" -p "$B" -m "Review: $name (snapshot of $H)")
br="claude/kind-knuth-01h2a1-review-$name"
git push -qf origin "$B:refs/heads/$br-base" "$R:refs/heads/$br"
echo "$br $(git diff --name-only "$B" "$R" | wc -l) files"
