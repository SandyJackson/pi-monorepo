# tmux-subagent

Pi subagents that run as interactive Pi sessions on a private tmux server
(`tmux -L pi-subagents`), out of your normal tmux navigation. The design is in
[`docs/specs/tmux-subagents.md`](../../docs/specs/tmux-subagents.md).

## Picker and inspection float

Run `/subagents` in a Pi started inside tmux. It lists this conversation's
children, each followed by the children it created, with their state. Type to
search.

- Enter resumes the child if it is stopped, then opens a modal floating pane
  attached to it. If the window already has a float, it shows tmux's error
  and does nothing else.
- Escape or Ctrl+C closes the float. Both keys are taken by tmux, so they do
  not reach the child. Closing ends only the attach client; the child keeps
  running.
- Ctrl+X stops the selected child after confirmation. Work in progress is
  lost. Transcripts and records are kept, and the next request or open resumes
  the child.

`/subagents` is not available inside a child.

### CLI

`cli.ts` lists and stops the children of a worktree, for inspection and for
cleaning up orphans. It runs with plain `node` (Node 22.18 or later, for
native type stripping) and does not load Pi.

```text
node cli.ts list  [--worktree <path>] [--json]
node cli.ts stop  <childId> | --worktree <path>
```

- `list` groups the worktree's children by parent conversation, with a
  grandchild under `child <childId>`, its creating child. It only reads state
  and never starts Pi.
- `stop` ends the child's Pi process, or every child of the worktree.

### Child conversations

A child stays in the conversation its parent created. `/new`, `/resume`,
`/import`, `/fork`, and `/clone` are blocked inside it. `/reload` and navigation
within its conversation tree still work. Stopping a child only ends its
process; opening it again resumes that same conversation.

Forking or switching the parent does not transfer its children to another
conversation. Resuming the original parent restores access to its children.

### Key settings

Your outer tmux server needs Pi's documented key settings so modified keys
reach Pi through the nested client:

```tmux
set -s extended-keys on
set -s extended-keys-format csi-u
```

### Environment

- `PI_CODING_AGENT_DIR`: Pi's agent directory. State lives in its
  `subagents/` directory (default `~/.pi/agent/subagents`).
- `PI_SUBAGENT_TMUX_SOCKET`: private server socket name (default
  `pi-subagents`).
- `PI_SUBAGENT_OUTER_TMUX_SOCKET`: operator server socket name. Unset in
  normal use: tmux finds your server through Pi's `TMUX`. Tests set it to a
  disposable server.

The state directory binds to its first socket in `tmux-socket.json`. Parents,
children, and the CLI must use the same `PI_SUBAGENT_TMUX_SOCKET`; a mismatch
is rejected before opening or stopping a child. For another socket, use a
separate `PI_CODING_AGENT_DIR`. Existing unbound state adopts the socket on
first use. Restart existing parents and children after upgrading so they all
use the check.

A child resumed from the picker gets the environment of the Pi that ran
`/subagents`.
