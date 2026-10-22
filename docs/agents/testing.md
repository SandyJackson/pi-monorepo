# Test selection and checks

The routine suite should finish in about ten seconds on a development machine. Full issue-loop CLI runs are integration tests, not the default feedback loop. Keep small, bounded integration tests in the fast suite when they fit that budget; move slow lifecycle tests out rather than increasing routine timeouts.

## Commands

Use Node 22.18 or newer. The affected-check script uses Node's native TypeScript support.

| Command | Scope |
| --- | --- |
| `pnpm test` or `pnpm test:fast` | All fast tests across the workspace |
| `pnpm test:issue-loop` | Every issue-loop test, including its CLI integration scenarios |
| `pnpm test:affected` | Fast tests, then integration tests for affected packages and their consumers |
| `pnpm check:affected` | Lint, typecheck, then the affected test selection |
| `pnpm test:all` | All tests, with opt-in smoke tests still opt-in |

While editing, use a targeted command such as:

```sh
pnpm exec vitest run packages/issue-loop/hook-failures.test.ts
pnpm exec vitest run packages/issue-loop/cli-commits.test.ts -t "repairs a code hook failure"
```

Before work is ready, use `pnpm check:affected`. The fast tests run before the selected integration tests, and each test runs only once. A failed command stops the check. `vitest.config.ts` uses two thirds of the CPUs and runs at most three issue-loop CLI tests concurrently per file, which bounds subprocess contention while keeping the longest file from setting the suite's duration.

## What is fast?

`vitest.fast.config.ts` extends the normal configuration. `scripts/test-policy.ts` owns the slow-test patterns. Currently these are issue-loop `cli-*.test.ts`, `*.integration.test.ts`, `*.smoke.test.ts`, the real-Pi delegated-task startup tests, and the affected-selection tests in `scripts/test-affected.test.ts` (a `scripts/` change selects the full suite anyway). Remaining tests include settings, parsers, artifact classification, worker state-machine tests, resource checks, and inexpensive package tests.

New tests use the cheapest seam that proves the behaviour. Keep representative CLI/RPC/process tests for wiring, real Git, signals, shutdown and crash recovery. Test diagnostic-string variations and workflow policy through smaller interfaces. A `.md` suffix does not make a runtime resource ordinary documentation.

`pnpm exec vitest run` still runs everything. Use `pnpm test:fast` for routine feedback rather than relying on import-based changed-test discovery, which cannot see all subprocess and Markdown inputs.

## Affected selection

Preview without executing checks:

```sh
pnpm test:affected --list
pnpm check:affected --list --base master
```

For an explicit check, the default base is the merge-base of `HEAD` and the local `refs/remotes/origin/HEAD`. The selection includes committed branch changes, staged changes, unstaged changes and untracked files. Renames include the old and new paths so moving a file out of a package does not hide its impact. `--base REF` selects a different branch or commit. Tracking refs are not fetched automatically; refresh them when necessary.

Selection is conservative:

- Package source, tests, fixtures and runtime resources select that package and its transitive workspace consumers. Dependencies, peer dependencies, optional dependencies and development dependencies all contribute edges.
- A change to `packages/session-auto-name/` does not select issue-loop integration tests. A change to the shared agent parser in `packages/herdr-subagent/` does.
- Issue-loop agent definitions and curated skills select issue-loop integration tests. Package `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE.md`, and Markdown under a package's `docs/` do not.
- Root Markdown and Markdown under `docs/` keep the fast suite. Root fast-test files also keep it.
- Changes to any package manifest select the full suite because they can rename packages or remove dependency edges from the graph used for selection.
- Shared root configuration, dependencies, tooling, workspace-wide runtime resources, deleted/unknown packages and other unclassified inputs select the full suite. That includes the lockfile, test configuration, hook configuration, `scripts/`, root agents, skills and prompt templates.
- If the default base or an old remote commit is unavailable, run all tests. An invalid explicit `--base` is an error, not a reason to silently skip tests.

Broad refactors or uncertainty warrant `pnpm test:all` even if the automatic plan is narrower. Run the full suite periodically as protection against missing dependency declarations or selection rules. No scheduled CI job is installed by these commands.

## Hooks

Pre-commit stays cheap: staged-file Biome checks and typecheck. Pre-push runs `pnpm check:affected --pre-push`, with Git's ref updates forwarded through Lefthook's `use_stdin` option.

For an existing remote branch, pre-push compares the old remote commit with the commit being pushed, not every earlier change on the local branch. A new branch uses the default comparison base. Deletions do not select package integration tests. Multiple updates are combined. Uncommitted changes are included because checks execute against the working tree.

The checkout must match each non-deleted commit being pushed; pushing another branch's commit is refused rather than testing the wrong source. Check out that branch and push again. An empty ref stream, as with a manual Lefthook invocation, uses the ordinary branch comparison.

`pnpm install` installs the hooks; after pulling this configuration you can also run `pnpm exec lefthook install`. Hook failures must be fixed rather than bypassed. A successful check need not be repeated for the same unchanged tree merely because work moves from implementation to review.

The hook does not create a clean snapshot or replace CI validation of the pushed commit. If uncommitted work could mask a regression, run checks from a clean checkout of the commit being reviewed.
