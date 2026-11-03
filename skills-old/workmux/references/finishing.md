# Merging and removal

This is a destructive action; be sure you have approval from the user before doing this!

Commit changes and pass repository checks before merging. Keep verification
hooks enabled.

```bash
workmux merge <handle>                 # Configured strategy and target
workmux merge <handle> --rebase        # Rebase, then fast-forward
workmux merge <handle> --squash        # One commit on the target
workmux merge <handle> --into <branch>
```

The target defaults to `main_branch`, otherwise the detected primary branch.
Merge normally deletes the worktree, session, and local branch.
`--keep` retains them; `--cleanup` overrides configured `merge_keep`.
You should know from the user or context what strategy to use. If not ask!

## Cleanup

```bash
workmux remove <handle>                # Delete without merging
workmux remove <handle> --keep-branch
workmux rm --gone                      # Upstream branch deleted remotely
```

Before removal, check uncommitted changes, important ignored files, unmerged
commits, and active terminal work. Remote branch deletion does not prove
a PR was merged.

`--force` skips confirmation and ignores uncommitted changes.
Use `--all` only for explicitly requested bulk cleanup.

Cleanup terminates the associated session. Run from elsewhere if you need
the calling terminal to survive.
