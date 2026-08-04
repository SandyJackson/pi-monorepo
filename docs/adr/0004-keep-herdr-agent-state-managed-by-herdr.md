---
status: accepted
---

# Keep herdr-agent-state managed by Herdr

`herdr-agent-state.ts` remains an externally managed extension and is not part of the Pi workspace aggregate package. The workspace owns the authored Herdr extensions and their event contract, while Herdr remains the source of truth for the state integration that it may overwrite during installation or upgrade.
