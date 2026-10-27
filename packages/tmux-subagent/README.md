# tmux-subagent

Pi subagents that run as interactive Pi sessions on a private tmux server
(`tmux -L pi-subagents`), out of your normal tmux navigation. The design is in
[`docs/specs/tmux-subagents.md`](../../docs/specs/tmux-subagents.md).

## Picker and inspection float

`cli.ts` lists, opens, and stops the children of a worktree. It runs with
plain `node` (Node 22.18 or later, for native type stripping) and does not
load Pi.

```text
node cli.ts pick  --pane <outer pane id>
node cli.ts open  <childId> --pane <outer pane id>
node cli.ts list  [--worktree <path>] [--json]
node cli.ts stop  <childId> | --worktree <path>
```

- `pick` shows a menu of the children whose owning worktree is that of the
  pane's current path, grouped by parent conversation. A grandchild is listed
  under `child <childId>`, its creating child. Choosing a child runs `open`.
- `open` resumes the child if it is stopped, then opens a modal floating pane
  attached to it. If the window already has a float, it shows tmux's error
  and does nothing else.
- Close the float with your outer server's `kill-pane` (for example
  `prefix x`). This ends only the attach client; the child keeps running.
- `stop` ends the child's Pi process, or every child of the worktree. Work in
  progress is lost. Transcripts and records are kept, and the next request or
  `open` resumes the child.
- `list` only reads state. It never starts Pi.

### Key binding

Nothing changes your tmux configuration. To use the picker, add a binding to
your own `tmux.conf`, with the path to this package:

```tmux
bind-key S run-shell -b 'node /path/to/packages/tmux-subagent/cli.ts pick --pane "#{pane_id}"'
```

Your outer tmux server also needs Pi's documented key settings so modified
keys reach Pi through the nested client:

```tmux
set -s extended-keys on
set -s extended-keys-format csi-u
```

The binding does not set these for you.

### Environment

- `PI_CODING_AGENT_DIR`: Pi's agent directory. State lives in its
  `subagents/` directory (default `~/.pi/agent/subagents`).
- `PI_SUBAGENT_TMUX_SOCKET`: private server socket name (default
  `pi-subagents`).
- `PI_SUBAGENT_OUTER_TMUX_SOCKET`: operator server socket name. Unset in
  normal use: from `run-shell`, tmux finds your server through `TMUX`. Tests
  set it to a disposable server.

A child resumed from the picker gets the environment of the process that ran
the CLI, which under `run-shell` is your outer tmux server's.
