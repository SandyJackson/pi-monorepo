# Agent workflows

Load this reference only when the user explicitly requests workmux-based
agent management. For normal delegation, use dedicated agent tools.

## Dispatch into a worktree

When asked to dispatch, write the prompt using context already available.
The new agent investigates the codebase; the dispatcher need not research
it first.

Run from the target repository:

```bash
workmux add <branch> --session -b -P <absolute-prompt-file>
```

Use the configured default agent unless the user requests one, then add
`-a <agent>`. This deliberately executes configured pane commands.
Include the task, constraints, known context, and expected checks in the
prompt. Report the resulting handle and path.

## Inspect and direct existing agents

Reuse known handles and batch relevant status and capture commands in one
tool call. If handles are unknown, inspect `workmux status` or the dashboard
before collecting output.

```bash
workmux status <handle>
workmux capture <handle> -n 50
workmux send <handle> "follow-up instructions"
workmux send <handle> -f <instruction-file>
workmux wait <handle> --timeout 3600
```

Agent handles can resolve globally. Use `project:handle` when names collide.
Skip idle shells and unrelated projects. Report task progress, blockers,
and completion evidence. An agent's reported "done" status is not proof
that tests passed or the requested work is complete.

Use `workmux run <handle> -- <command>` to run a shell command in its
worktree; add `-b` for background execution.

## Start an agent in an existing project checkout

A request to open an agent in a project can mean a terminal agent in that
project's tmux session, without creating a worktree. Resolve the project
directory from known context or existing session metadata:

```bash
tmux list-sessions -F '#{session_name}\t#{session_path}'
```

Reuse an existing project session:

```bash
tmux new-window -d -P -F '#{window_id}' -t <project> -n <name> \
  -c <project-path> <agent>
```

If it does not exist:

```bash
tmux new-session -d -P -F '#{window_id}' -s <project> -n <name> \
  -c <project-path> <agent>
```

Retain the returned window ID for subsequent operations. Switch the client
only when requested. Successful creation output is sufficient confirmation;
avoid listing windows again just to rediscover the new one.

For a separate worktree, use session-mode `workmux add` instead. Window-mode
placement with `--parent-session` is covered in [Worktrees](worktrees.md).
