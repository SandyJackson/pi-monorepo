# Validate installations and perform cutover

## What to build

Prove the Pi workspace works as a global development installation and a GitHub bootstrap installation, then switch the active runtime from copied dotfiles resources to the workspace package without duplicating resources or taking ownership of managed state.

## Acceptance criteria

- [ ] A clean temporary Pi environment can load the workspace from a local checkout.
- [ ] A clean temporary Pi environment can install and load the workspace from the GitHub default branch.
- [ ] SSH and HTTPS authentication instructions are documented for GitHub installation.
- [ ] Pi's pnpm package-manager configuration, global installation scope, default-branch update flow, and `/reload` workflow are documented.
- [ ] `pi-web-access` is documented as a separately installed external package required by the relevant agents.
- [ ] Manual copying of workspace agents into the active global agent directory is documented and verified.
- [ ] Migrated copies are removed from the old runtime tree so extensions, skills, and agents are not loaded twice.
- [ ] Unrelated Pi packages, settings, runtime state, and the Herdr-managed state extension remain intact.
- [ ] Local development and GitHub update instructions are verified after cutover.

## Blocked by

- Port the authored runtime
- Migrate workspace resources

## Blocking

None — this completes the migration.
