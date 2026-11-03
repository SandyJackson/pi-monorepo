---
name: git-rebase
description: Reshape a messy, git branch history into a small approved series of atomic commits. Use before opening or updating a pull request when commits and fixes need reordering, folding, splitting, or rewording. Do not use on shared branches, feature ranges containing merge commits, or when the final source should change.
compatibility: Requires Git and Bash.
disable-model-invocation: true
---

# Curate Feature Branch History

Turn a messy feature branch into a small, intentional commit series without changing its final tree. Keep history cleanup separate from target integration so conflicts have a clear cause.

## Guardrails

- Work only on an unshared feature branch. Ask if ownership is unclear.
- Confirm the merge target; never assume `origin/main`.
- Do not change source behaviour during history cleanup.
- Do not flatten merge commits. Stop if the feature range contains merges.
- Show the proposed final commits and exact rebase actions before rewriting history. Get approval.
- Never push without explicit approval. Use `--force-with-lease`, never `--force`.

## 1. Establish the boundaries

Fetch the confirmed target's remote without modifying the feature branch. Record these immutable values:

```bash
git branch --show-current
git rev-parse --verify '<target>^{commit}'
git merge-base HEAD <target-commit>
```

Treat the outputs as `<feature-branch>`, `<target-commit>`, and `<branch-point>`. Do not silently recalculate them later.

Check the feature range and repository state:

```bash
git status
git rev-list --merges <branch-point>..HEAD
git log --reverse --format='%H %s' <branch-point>..HEAD
```

Stop if the worktree is dirty, another Git operation is active, the target is invalid, or the merge query returns commits. Run the branch's existing relevant tests to establish a baseline.

Create a backup before any history mutation. Resolve the script path relative to this `SKILL.md` while keeping the feature repository as the working directory:

```bash
bash <skill-directory>/scripts/pre-rebase-backup.sh
```

Record the printed branch as `<cleanup-backup>`. CREATING A BACKUP IS MANDATORY.

## 2. Design the cleaned history

Inspect the complete feature diff and each source commit. Propose a short ordered series, normally 3–4 commits, but you can be flexible§. For each proposed commit state:

- message and single purpose
- source commits it absorbs
- commits or hunks that must be split
- dependency on earlier proposed commits
- validation to run after it

Fold fixes into the commit whose intent they complete. Do not preserve accidental chronology, but do preserve meaningful logical boundaries. Each resulting commit should be reviewable and valid on top of its predecessor.

Present the exact interactive-rebase todo using `pick`, `reword`, `fixup`, and `edit`. Include `exec` validation after a completed logical commit when practical. Do not begin until the user approves the plan.

## 3. Rebuild the feature series

While checked out on the feature branch, run the approved plan from the original branch point:

```bash
git rebase -i <branch-point>
```

This phase must not move the feature onto the target. If a terminal editor is unavailable, save the exact approved todo in a temporary file and use a small `GIT_SEQUENCE_EDITOR` wrapper to copy it into Git's todo. Display the plan before execution and remove both temporary files afterwards; do not rewrite the todo with opaque search-and-replace commands.

To split a commit marked `edit`:

```bash
git reset HEAD^
# Stage and commit each approved logical part in order.
git rebase --continue
```

Do not add unrelated corrections while splitting. Handle new code changes separately after history cleanup.

## Conflict loop

During any rebase, Git's sides are:

- ours / stage 2 / `HEAD`: the new base plus commits already rebuilt
- theirs / stage 3: the original commit currently being replayed

Inspect before resolving:

```bash
git status
git diff --name-only --diff-filter=U
git rebase --show-current-patch
git show :2:path/to/file  # ours, when present
git show :3:path/to/file  # theirs, when present
```

For a history-cleanup conflict, make the replayed commit coherent at its approved position. Do not copy the final file from `<cleanup-backup>`: that can pull later changes into an earlier commit.

If resolution requires substantial code from a commit planned for later, the plan is probably ordered incorrectly. Abort and revise it rather than manufacturing a misleading intermediate commit:

```bash
git rebase --abort
```

Otherwise resolve intentionally, stage only resolved files, inspect the staged result, and continue:

```bash
git add <resolved-files>
git diff --cached --check
git diff --cached
git rebase --continue
```

Do not skip an empty commit automatically. First confirm its complete intent is already present; use `git rebase --skip` only when it is genuinely redundant in the approved plan.

## 4. Verify history cleanup

After the interactive rebase:

```bash
git status --short
git diff --exit-code <cleanup-backup> HEAD
git log --reverse --stat <branch-point>..HEAD
```

The worktree must be clean, and the tree diff against the backup must be empty. Confirm the resulting commits match the approved purposes and order. Run the planned per-commit checks where practical and the full relevant test suite. Do not start target integration if any check fails.

## 5. Rebase the cleaned series onto the target

If `<target-commit>` is already an ancestor of `HEAD`, skip this phase. Otherwise create and record a second backup, then run a non-interactive rebase:

```bash
bash <skill-directory>/scripts/pre-rebase-backup.sh
git rebase <target-commit>
```

Record the second backup as `<integration-backup>`. Conflicts in this phase mean a cleaned feature commit conflicts with newer target behaviour. Preserve the feature commit's intent while integrating the target; exact tree equality with the original backup is no longer expected.

Validate the result:

```bash
git status --short
git merge-base --is-ancestor <target-commit> HEAD
git log --reverse --stat <target-commit>..HEAD
git range-diff <branch-point>..<integration-backup> <target-commit>..HEAD
```

Run the full relevant checks. Summarize the final commit series and any conflict decisions. Ask before pushing the rewritten branch with its configured upstream and `--force-with-lease`.

## Recovery

During an active rebase, prefer:

```bash
git rebase --abort
```

After a completed rewrite, stop and use the recorded backup branch to inspect or restore the prior state. Never reset, delete backup branches, or push without explicit approval.
