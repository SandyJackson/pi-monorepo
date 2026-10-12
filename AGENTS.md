# Repository tooling and rules

This repository uses `pnpm` for all of its tooling. Speak to the user.

Significant pieces of work should always take place on a separate worktree,
not on `master` or `main`.
Worktrees are managed with worktrunk load the skill for more information.

## Checks

Confirm a change cheapest first, so lint and type errors fail in seconds
rather than after the two-minute test suite:

1. `pnpm lint` (fix with `pnpm lint:fix`)
2. `pnpm typecheck`
3. `pnpm exec vitest run` (full suite)

While iterating, scope Vitest to what you are changing, e.g.
`pnpm exec vitest run packages/issue-loop/cli.test.ts -t "<test name>"`.
The full suite already includes every package's tests, so run it once at the end.

Always invoke repo binaries with `pnpm exec`, never `npx`.
`npx` can resolve unpinned versions (notably biome) that disagree
with the repo's locked toolchain. Pre-commit hooks run biome on
staged files plus typecheck automatically.
Do not try to bypass these pre-commit hooks if you cannot get the tests passing
speak to the user.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `SandyJackson/pi-monorepo`; external pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
