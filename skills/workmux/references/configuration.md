# Configuration

## Find the effective settings

Workmux has global configuration at `~/.config/workmux/config.yaml` and
project configuration in `.workmux.yaml`. Project values override global
values. Inspect both before relying on setup behaviour.

```bash
workmux config path        # Locate global configuration
workmux config reference   # Print the documented configuration options
workmux config edit        # Open global configuration in the user's editor
workmux init               # Generate project configuration
```

Do not initialise or edit configuration just to inspect it. Use
`workmux config reference` as the full option catalogue rather than copying
its contents into this skill.

## Session mode

The expected workflow is one tmux session per worktree:

```yaml
mode: session
```

For a one-command override, use `--session` with `add` or `open`.
`window_prefix` affects session names too, despite its name.
`default_session` chooses the session to return to when a managed session
is closed or removed.

Session mode supports a `windows` list, each with its own `panes`.
Alternatively, `panes` defines a single-window layout. These settings are
mutually exclusive.

## Startup effects

Check all three sources of startup effects:

- `files.copy` and `files.symlink` provision files from the main worktree.
- `post_create` runs setup commands before the terminal target opens.
- Commands in `panes` or `windows[].panes` run in the new terminal layout.

The `<agent>` placeholder expands to the configured agent command.
A background session can therefore start an agent without an explicit
agent flag.

Use headless creation when no terminal target is needed. Use
`--no-pane-cmds` with session creation when plain shells are wanted.
Neither skips file operations or post-create hooks.
`--no-hooks` and `--no-file-ops` control those separately.

A symlink shares the original resource rather than copying it. Check
whether sharing dependencies or mutable files is appropriate before
configuring symlinks.

## Branches and lifecycle hooks

- `base_branch` controls the starting point for new branches.
  `--base` overrides it; `auto` selects the primary branch.
- `main_branch` controls the default merge target.
- `merge_strategy` and `merge_keep` control merge style and cleanup.
- `pre_merge` supplies checks that must pass before merge.
- `pre_remove` supplies cleanup or backup commands before removal.

Use `"<global>"` in supported project arrays to include global entries.
Check the configuration reference for the specific setting's inheritance
rules rather than assuming arrays concatenate.
