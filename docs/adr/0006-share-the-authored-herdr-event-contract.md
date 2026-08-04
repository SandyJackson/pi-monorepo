---
status: accepted
---

# Share the authored Herdr event contract

The workspace will contain a small non-extension contract package defining the `herdr:blocked` event name and payload type. Authored extensions use that package for consistent emission, while the externally managed Herdr state extension continues to consume the stable event contract without depending on workspace code.
