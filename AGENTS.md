# Repository tooling and rules

This repository uses `pnpm` for all of its tooling. Speak to the user.

Significant pieces of work should always take place on a separate worktree,
not on `master` or `main`.
Worktrees are managed with worktrunk load the skill for more information.

## Checks

While iterating, run the relevant tests, e.g.
`pnpm exec vitest run packages/issue-loop/cli-lifecycle.test.ts -t "<test name>"`.
Routine checks are cheapest first:

1. `pnpm lint` (fix with `pnpm lint:fix`)
2. `pnpm typecheck`
3. `pnpm test:fast`

Before declaring work ready or pushing, run `pnpm check:affected`. It runs lint,
typecheck, the fast suite, and integration tests for changed packages and their
workspace consumers. Pre-push runs it automatically against Git's pushed refs.
Use `pnpm test:affected --list` to preview selection, or `--base REF` to choose
a comparison base for an explicit check.

Use `pnpm test:all` for shared tooling/dependency changes, broad refactors, or
uncertain impact, not after every local change. The selector falls back to the
full suite for shared or unclassified inputs. See `docs/agents/testing.md` when
changing check selection, hooks, or test tiers, or diagnosing a slow check.

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
