---
status: accepted
---

# Use one aggregate Pi package with child extension workspaces

The repository uses a private root aggregate package for Pi installation, with shared `skills/` and `agents/` resources at the root and one child workspace package per extension under `packages/`. This preserves clear dependency and testing boundaries without requiring each personal extension to be independently installed or released.
