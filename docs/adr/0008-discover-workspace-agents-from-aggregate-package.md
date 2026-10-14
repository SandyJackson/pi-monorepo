---
status: accepted
---

# Discover workspace agents from the aggregate package

Supersedes [ADR-0007](./0007-sync-workspace-agents-into-existing-global-discovery.md). Manual copying lets stale user-directory copies shadow repository updates, so `herdr-subagent` now discovers workspace agents from the aggregate package's `agents/` directory relative to the extension. Precedence is project > user > workspace, preserving local customisation while exposing project agents only for trusted projects.

The callable agent catalog remains a session-scoped snapshot with unchanged listing behaviour. Discovery covers this aggregate package, not arbitrary installed Pi packages. Users must remove previously copied workspace agents from their user agent directory during rollout or those copies will continue to override package versions; see [the migration steps](../agent-discovery.md#remove-previously-copied-agents).
