---
name: workmux
description: Create and manage git worktrees with workmux. Use for worktree creation, lookup, tmux sessions, merging, and cleanup.
---

# workmux

- Session mode is the default. Run commands from the target repository.

## Everyday commands

```bash
workmux list                             # List worktrees
workmux add <branch> -b                  # Create a worktree without switching
workmux add <branch> --headless --json   # Create without a tmux session
workmux path <handle>                    # Print the worktree path
workmux open <handle> --session          # Open or switch to its session
workmux close <handle>                   # Close its session, keep the worktree
```

- Create without switching. Switch sessions only when requested.
- Check the current branch and changes before creating a worktree.
- Add `--base <ref>` to choose its starting point.
- `-b` avoids switching sessions; `--no-pane-cmds` prevents configured
  commands from starting agents.
- For a worktree without tmux, use `workmux add <branch> --headless --json`.
- Use dedicated agent tools for delegation, not workmux, unless instructed.

## Less common tasks

Read only when needed:
- [Creation options and PR checkout](references/worktrees.md)
- [Merging and removal](references/finishing.md)
- [Configuration and hooks](references/configuration.md)
- [Agent management](references/agents.md), only when explicitly requested

