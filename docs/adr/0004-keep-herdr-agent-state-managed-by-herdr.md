---
status: superseded by ADR-0011
---

# Keep herdr-agent-state managed by Herdr

Superseded by [ADR-0011](./0011-workspace-owns-subagent-run-state.md): subagent run state is now recorded by the workspace's `tmux-subagent` package, not observed through Herdr.

`herdr-agent-state.ts` remains an externally managed extension and is not part of the Pi workspace aggregate package. The workspace owns the authored Herdr extensions and their event contract, while Herdr remains the source of truth for the state integration that it may overwrite during installation or upgrade.
