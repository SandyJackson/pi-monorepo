# Port the authored runtime

## What to build

Move the four authored extensions into child workspace packages and make the aggregate package load them with their existing behavior. Establish the shared authored Herdr event contract while keeping the externally managed Herdr state extension outside the workspace.

## Acceptance criteria

- [ ] Bash permission, Herdr subagent, Herdr bridge, and session auto-name load from the aggregate package.
- [ ] Existing extension behavior, tool registrations, lifecycle hooks, event payloads, permission decisions, session naming, and project-trust behavior remain unchanged.
- [ ] Pi development imports type-check against the exact installed Pi release.
- [ ] Tree-sitter dependencies resolve as normal runtime dependencies rather than paths into the old Pi runtime directory.
- [ ] The authored `herdr:blocked` event name and payload are represented by a shared contract without changing the runtime contract.
- [ ] Focused tests cover bash policy/extraction, the Herdr event contract, and extension loading at the highest practical seam.
- [ ] The Herdr-managed state extension is not copied into the aggregate package.

## Blocked by

- Establish the pnpm Pi workspace

## Blocking

- Validate installations and perform cutover
