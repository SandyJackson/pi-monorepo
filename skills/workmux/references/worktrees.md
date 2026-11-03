# Worktrees

## Identify the workspace

Run commands from the target repository, not whichever checkout happens
to be the current directory.

```bash
git branch --show-current
git status --short
git worktree list
workmux list
workmux path <handle>
```

Use handles reported by workmux rather than guessing paths. Naming and
directory locations are configurable. Defaults are a sibling directory
named `<project>__worktrees/<handle>` and a tmux target prefix of `wm-`.

## Create without a session

For an isolated workspace without starting terminal processes:

```bash
workmux add <branch> --headless --json
```

Use an explicit local branch name. The JSON receipt supplies the handle,
worktree path, and effective working directory. Hook output goes to stderr.
No running multiplexer is required.

Headless creation runs file operations and post-create hooks. Inspect
[Configuration](configuration.md) when those effects matter.
It supports `--base`, `--name`, `--no-hooks`, and `--no-file-ops`,
but not PR checkout, prompts, background creation, or mux/agent options.
The worktree persists until removed.

## Create a tmux session

Use session mode and avoid switching the user's client:

```bash
workmux add <branch> --session -b --no-pane-cmds
```

`--no-pane-cmds` opens plain shells instead of executing configured pane
commands. File operations and post-create hooks still run. Use this when
a session is wanted but configured commands would start unwanted processes.

When the user requests the configured terminal layout and its startup
commands, omit `--no-pane-cmds`:

```bash
workmux add <branch> --session -b
```

Check startup commands first. Neither `-b` nor session mode prevents them
from launching agents. Workmux-based agent workflows require an explicit
request; see [Agent workflows](agents.md).

## Choose the branch and setup

- `--base <ref>` selects the starting branch, commit, or tag. Without it,
  the configured `base_branch` applies, otherwise the current branch.
- `--name <handle>` overrides the worktree handle.
- `--target-name <name>` overrides the managed tmux target name.
- `-o` opens an existing worktree instead of failing. Opening may switch
  the client, so use it only when that behaviour is intended.
- `--no-hooks` skips post-create hooks.
- `--no-file-ops` skips configured copies and symlinks.

Keep required project setup enabled unless there is a reason to skip it.
Use `workmux add --help` for options not covered here.

### Move existing changes

```bash
workmux add <branch> --session -b --no-pane-cmds --with-changes
```

This moves uncommitted changes out of the current worktree. Inspect the
changes and confirm they belong to the task first. Add `--include-untracked`
when untracked files must move too. Never move unrelated user work.

### Check out a pull request

```bash
workmux add --pr <number-or-url> --session -b --no-pane-cmds
```

The local branch defaults to the PR head branch. Supply a branch name to
override it. GitHub checkout requires authenticated `gh`.
This is not available in headless mode.

## Open and close sessions

```bash
workmux open <handle> --session
workmux close <handle>
```

Opening switches to the existing session or creates a missing target.
A newly created target can run configured pane commands, so inspect the
configuration before opening a headless worktree. Closing keeps the
worktree and branch but terminates its terminal session and processes.
Check for active work before closing.

`open --run-hooks` reruns post-create hooks; `--force-files` reapplies file
operations. Neither is needed for routine opening.

## Session placement and window mode

This workflow uses one session per worktree. A session can contain several
configured windows. Use `--session` to override window-mode configuration
for `add` or `open`.

`--parent-session` is for window mode, not session mode. Only when window
mode is explicitly requested, run from the target repository and use:

```bash
workmux add <branch> --mode window -b --no-pane-cmds \
  --parent-session <session>
```

Workmux creates the parent session if needed. Repository selection and
terminal placement are independent; a session name does not select a repo.
