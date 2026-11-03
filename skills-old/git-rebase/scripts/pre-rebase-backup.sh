#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_NAME="${0##*/}"

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

report_unexpected_error() {
    local exit_code=$?
    printf 'ERROR: %s failed at line %s while running: %s\n' \
        "$SCRIPT_NAME" "${BASH_LINENO[0]}" "$BASH_COMMAND" >&2
    exit "$exit_code"
}

trap report_unexpected_error ERR

if (( $# != 0 )); then
    fail "Usage: $SCRIPT_NAME"
fi

command -v git >/dev/null 2>&1 || fail "Git is not installed or is not on PATH."

inside_worktree="$(git rev-parse --is-inside-work-tree 2>/dev/null)" ||
    fail "Run this script from inside a Git working tree."
[[ "$inside_worktree" == "true" ]] ||
    fail "Run this script from inside a Git working tree."

current_branch="$(git symbolic-ref --quiet --short HEAD)" ||
    fail "HEAD is detached; check out the branch you want to back up."

worktree_status="$(git status --porcelain=v1 --untracked-files=all)"
if [[ -n "$worktree_status" ]]; then
    printf 'ERROR: The working tree is not clean:\n%s\n' "$worktree_status" >&2
    fail "Commit, stash, or remove these changes before creating a pre-rebase backup."
fi

source_commit="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" ||
    fail "The current branch has no commit to back up."
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
short_commit="${source_commit:0:12}"
backup_branch="backup/rebase/${current_branch}/${timestamp}-${short_commit}"
backup_ref="refs/heads/${backup_branch}"

git check-ref-format "$backup_ref" >/dev/null ||
    fail "Git rejected the generated backup branch name: $backup_branch"

if git show-ref --verify --quiet "$backup_ref"; then
    fail "Backup branch already exists: $backup_branch"
fi

if ! git branch "$backup_branch" "$source_commit"; then
    fail "Git could not create backup branch: $backup_branch"
fi

backup_commit="$(git rev-parse --verify "${backup_ref}^{commit}")"
[[ "$backup_commit" == "$source_commit" ]] ||
    fail "Backup verification failed: expected $source_commit, found $backup_commit"

printf 'Backup created successfully.\n'
printf '  Source: %s at %s\n' "$current_branch" "$source_commit"
printf '  Backup: %s\n' "$backup_branch"
