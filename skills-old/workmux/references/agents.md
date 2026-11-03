# Agent management

Only use this workflow when explicitly requested. Otherwise use dedicated
agent tools.

## Dispatch

Write a prompt from existing context; leave investigation to the new agent.

```bash
workmux add <branch> --session -b -P <absolute-prompt-file>
```

Use the configured agent, or `-a <agent>` when requested.
Report the handle and path.

## Monitor and direct

```bash
workmux status <handle>
workmux capture <handle> -n 50
workmux send <handle> "instructions"
workmux send <handle> -f <file>
workmux wait <handle> --timeout 3600
workmux run <handle> -- <command>
```

Reuse known handles; batch relevant status and capture calls.
Use `project:handle` for collisions. Report progress, blockers, and completion
evidence. A "done" status alone does not establish success.

## Existing checkout, no worktree

Resolve the project path from known context or
`tmux list-sessions -F '#{session_name}\t#{session_path}'`.

```bash
# Existing project session
tmux new-window -d -P -F '#{window_id}' -t <project> -n <name> \
  -c <project-path> <agent>

# No project session yet
tmux new-session -d -P -F '#{window_id}' -s <project> -n <name> \
  -c <project-path> <agent>
```

Keep the returned window ID. Switch only when requested.
