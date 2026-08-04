# Establish the pnpm Pi workspace

## What to build

Turn the empty repository into the private Pi workspace foundation: a pnpm workspace with one aggregate Pi package, shared root tooling, and the type/resource declarations needed for the authored workspace resources.

## Acceptance criteria

- [ ] A fresh checkout installs with pnpm using one root lockfile.
- [ ] The workspace declares Node 22+ compatibility and uses the exact installed Pi release for development types.
- [ ] The root aggregate package is private and exposes authored extension and skill resources through Pi's package manifest.
- [ ] Root strict noEmit typechecking and the focused test command are available.
- [ ] Pi-provided packages are available to TypeScript without bundling them into runtime resources.
- [ ] No runtime behavior or existing Pi resource is changed by the foundation work.

## Blocked by

None — can start immediately.

## Blocking

- Port the authored runtime
- Migrate workspace resources
