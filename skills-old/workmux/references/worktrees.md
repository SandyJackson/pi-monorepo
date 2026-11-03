# Creation options

## Pull requests and existing changes

```bash
workmux add --pr <number-or-url> -b
workmux add <branch> -b --with-changes
```

PR checkout uses the PR head branch name unless a local branch name is
supplied. GitHub requires authenticated `gh`.

`--with-changes` moves uncommitted changes from the current worktree.
Add `--include-untracked` to move untracked files too. Move only task-related
changes.

## Overrides

- `--name <handle>`: worktree handle.
- `--target-name <name>`: tmux target name.
- `--session`: override window-mode configuration.
- `--no-hooks`: skip post-create hooks.
- `--no-file-ops`: skip configured copies and symlinks.
- `--no-pane-cmds`: open plain shells instead of running pane commands.
- `-o`: open an existing worktree instead of failing; may switch sessions.

Headless creation requires an explicit local branch name. It still runs
hooks and file operations, but does not support PR checkout, prompts, or
multiplexer options. JSON output includes the handle and workspace paths.

## Reopening and placement

Opening a worktree with no running session can execute configured pane
commands. `open --run-hooks` reruns setup; `open --force-files` reapplies
copies and symlinks.

Only for window-mode placement:

```bash
workmux add <branch> --mode window -b --parent-session <session>
```

Workmux creates the parent session if needed. This flag does not apply to
session mode.

Use `workmux add --help` or `workmux open --help` for other options.
