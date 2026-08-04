---
status: accepted
---

# Synchronize workspace agents into existing global discovery

Workspace-owned agent definitions remain in the Pi workspace as source, but the initial installation/update documentation asks the user to manually copy them into Pi's existing global `agents/` directory. `herdr-subagent` keeps its current user/project discovery and precedence behavior, avoiding a runtime feature change while allowing agents to be versioned with the workspace. Direct package-manifest agent discovery is a future improvement, not part of this migration.
