---
status: superseded by ADR-0008
---

# Synchronize workspace agents into existing global discovery

Superseded by [ADR-0008](./0008-discover-workspace-agents-from-aggregate-package.md), which replaces manual copying with direct aggregate-package discovery.

Workspace-owned agent definitions remain in the Pi workspace as source, but the initial installation/update documentation asks the user to manually copy them into Pi's existing global `agents/` directory. `herdr-subagent` keeps its current user/project discovery and precedence behavior, avoiding a runtime feature change while allowing agents to be versioned with the workspace. Direct package-manifest agent discovery is a future improvement, not part of this migration.
