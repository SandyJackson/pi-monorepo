# Finishing work

Merging and removing can delete the worktree, its tmux session, and its
local branch. Check for uncommitted changes and active terminal work first.
Use an explicit handle when the current worktree is not the intended target.

## Merge locally

Commit the intended changes and run the repository's required checks before
merging. Keep verification hooks enabled.

```bash
workmux merge <handle> --rebase
```

The target defaults to configured `main_branch`, otherwise the detected
primary branch. Use `--into <branch>` for a different target.

Choose the strategy deliberately:
- No strategy flag uses configured `merge_strategy`, otherwise merge.
- `--rebase` rebases onto the target before a fast-forward merge.
- `--squash` combines the branch's commits into one target commit.

Successful merge normally removes the worktree, tmux session, and local
branch. Configuration can change this with `merge_keep`.
Use `--keep` to retain them or `--cleanup` to request cleanup explicitly.
Run cleanup from outside the session being removed when you need to
continue working after the command.

If the merge or a hook fails, inspect the failure and resolve it before
retrying. Preserve the worktree while the problem is unresolved.

## Finish through a pull request

1. Commit the intended changes and run required checks.
2. Push with `git push -u origin HEAD`.
3. Open a PR using the repository's normal workflow.
4. After remote merge, review cleanup candidates with
   `workmux list --pr` and Git's remote tracking information.

`workmux rm --gone` removes worktrees whose upstream branches have been
deleted remotely. Remote deletion is not itself proof that work was merged.
Confirm the candidate worktrees are safe to remove first.

## Remove without merging

```bash
workmux remove <handle>                 # Remove worktree, session, branch
workmux remove <handle> --keep-branch   # Retain the local branch
```

Removal is not a merge. Confirm that remaining work is preserved or
intentionally discarded. Check ignored files too when they contain local
data that matters.

Avoid `--force` in routine cleanup: it skips confirmation and ignores
uncommitted changes. Use `--all` only when the user has requested bulk
removal and the affected worktrees have been reviewed.

To close only the terminal session while retaining files and branch, use
`workmux close <handle>` instead.
