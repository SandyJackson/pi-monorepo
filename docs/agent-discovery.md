# Agent discovery

The workspace's `herdr-subagent` extension discovers callable agents from the aggregate package's `agents/` directory, located relative to the extension. Installing the aggregate package makes these workspace agents available without copying them into Pi's user agent directory. Discovery from arbitrary installed packages is outside this extension's scope.

## Precedence and trust

When names collide, precedence is **project > user > workspace**:

- Project agents come from the nearest ancestor `.pi/agents/` directory containing valid definitions, starting at the parent session's working directory. They are available only when that project is trusted.
- User agents come from `agents/` under Pi's agent directory, typically `~/.config/pi/agent/agents/`. They can override workspace agents.
- Workspace agents come from this aggregate package's `agents/` directory.

Untrusted projects retain workspace and user agents. The callable agent catalog is a session-scoped snapshot. File changes take effect at the next session lifecycle refresh, such as `/reload`. A delegated task's working directory does not change the catalog.

Call `subagent` with no arguments to list the catalog. Listings and tool descriptions omit source labels and use the same definitions as delegation.

## Remove previously copied agents

If you previously copied workspace agents into Pi's user agent directory, compare those files with this package's [`agents/`](../agents/) directory and delete the old copies from the user directory. Keep deliberately customised user agents that should override the package versions. Old copies otherwise continue to win over updated workspace agents.

If the user agent directory is a symlink to this workspace's `agents/` directory, remove the symlink itself, preserving its target and any unrelated user agents. Then restart Pi or run `/reload` and call `subagent` with no arguments to verify discovery.

## Agent file format

Discovery reads `.md` files with YAML frontmatter and a non-empty `description`. The name comes from `name`, or from the filename when `name` is absent. The body supplies the child's system prompt guidance.

```markdown
---
name: example
description: Explain existing code
tools: read, grep, find, ls, bash
model: provider/model
thinking: high
timeout: 90
---

Explain the requested code without editing it.
```

`tools` is an optional comma-separated string or YAML list of tool names. `model` is an optional model override. `thinking` is passed to visible subagents as `--thinking`; omit it to use Pi's default. `timeout` is an optional positive integer number of minutes setting the agent's default delegation timeout: the `subagent` call's `timeout` overrides it, an agent without one uses the 60-minute default, and an invalid value stops discovery with an error naming the file. See the package's [`agents/`](../agents/) directory for the available workspace definitions.
