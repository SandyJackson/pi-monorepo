---
status: accepted
---

# Workspace owns subagent run state

Supersedes [ADR-0004](./0004-keep-herdr-agent-state-managed-by-herdr.md). Subagents no longer run in Herdr panes, so settlement no longer reads Herdr's agent-state projection. `tmux-subagent` records each child's requests, results, status, and reports as files under Pi's agent directory, one writer per file, and runs children on a private tmux server. The workspace is now the source of truth for whether a child's request is queued, running, blocked, or settled. Herdr is not required.

`herdr-subagent` and `herdr-bridge` are removed. `herdr-contract` stays: `bash-permission` still emits `herdr:blocked`, and the child bridge consumes it to mark a child blocked ([ADR-0006](./0006-share-the-authored-herdr-event-contract.md)). The event name is unchanged. The design is in [Tmux subagents V1](../specs/tmux-subagents.md).
