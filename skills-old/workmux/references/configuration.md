# Configuration

Global settings live at `~/.config/workmux/config.yaml`; project overrides
live in `.workmux.yaml`. Inspect both when diagnosing behaviour.

```bash
workmux config path        # Global config location
workmux config reference   # Full option documentation
workmux config edit        # Edit global settings
workmux init               # Generate project config
```

## Settings worth knowing

- `mode: session`: one session per worktree.
- `windows`: multiple windows with their own panes, session mode only.
  Mutually exclusive with top-level `panes`.
- `window_prefix`: naming prefix for sessions too.
- `default_session`: return destination when a session closes.
- `base_branch`: starting point; defaults to current branch.
  `auto` selects the primary branch.
- `main_branch`: merge target.
- `merge_strategy`, `merge_keep`: merge style and cleanup.

## Setup and hooks

- `files.copy`, `files.symlink`: provision from the main worktree.
- `post_create`: setup before the terminal opens.
- `panes` or `windows[].panes`: terminal startup commands.
  `<agent>` expands to the configured agent.
- `pre_merge`: checks that gate merging.
- `pre_remove`: cleanup or backups before removal.

Headless mode skips terminal startup, not hooks or file operations.
Use `--no-hooks` and `--no-file-ops` to skip those separately.

Supported project arrays can include `"<global>"` to inherit global entries.
Consult `workmux config reference` for setting-specific inheritance rules.
