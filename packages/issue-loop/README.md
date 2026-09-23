# GitHub issue loop

A small local controller for one parent GitHub issue. It implements direct child tickets one by one on a single feature branch, runs your checks and independent Pi reviews, and opens one final PR. No workflow engine or Pi extension is required.

## Requirements

- macOS or Linux; Node 22.18+ or Node 24+.
- `git`, authenticated `gh`, and authenticated `pi` on PATH. Pi must support `-p`, `--name`, `--session`, `--approve`, and tool allowlists. Developed against Pi 0.86.1.
- A GitHub.com repository with `origin` pointing at the repo holding the parent issue. Fetch and push URLs must match. GitHub identity comes from `origin`, not `GH_REPO`.
- Open, implementation-ready child issues linked through GitHub's native sub-issue feature. Native blocked-by dependencies are respected. Task-list links are ignored.
- Requirements live in the parent and ticket bodies. Comments are never fetched or forwarded, so copy approved decisions into the relevant body before starting.
- A check command that terminates and exits nonzero on failure. No watch mode.

Both roles use your configured Pi model unless `--settings` overrides it. The new worktree loads Pi resources with `--approve`, which trusts project-local resources without bypassing your command permission extension. Authenticate Pi first so workers never face an interactive login.

## Start

From this workspace:

```sh
pnpm issue-loop start \
  --repo /absolute/path/to/project \
  --issue 123 \
  --setup 'pnpm install --frozen-lockfile' \
  --check 'pnpm typecheck && pnpm exec vitest run'
```

Or by absolute path from anywhere:

```sh
node /path/to/pi-monorepo/packages/issue-loop/run.mjs start \
  --repo /absolute/path/to/project \
  --issue 123 \
  --check 'make test'
```

`--setup` is optional. A fresh worktree has no untracked dependencies such as `node_modules`, so provide setup when you need it. It runs before the first ticket and again on resume after a failed setup, so keep it repeatable.

`--timeout SECONDS` caps each worker, setup, and check invocation. Default 1800, accepts 1-7200. Git/GitHub operations get 60 seconds. Ctrl-C stops the active process group, preserves work, and records a blocked run. A second interrupt escalates to SIGKILL.

## Customizing workers

`--settings ./loop-settings.json` overrides worker models, tool allowlists, role guidance, and a shared system-prompt addition. Every field is optional.

```json
{
  "implementAgent": "./agents/loop-implement.md",
  "reviewAgent": "./agents/loop-review.md",
  "appendSystemPrompt": "Prefer small, focused changes."
}
```

Agent files use the agent markdown format: frontmatter with `model` and `tools`, plus a prompt body that replaces the default role guidance only. Paths resolve relative to the settings file. The runner still supplies issue context, constraints, patch/check context, and the reviewer's required JSON verdict format.

An absent `tools` field keeps the built-ins (implement: `read,grep,find,ls,bash,edit,write`; review: `read,grep,find,ls`). An explicit list replaces them. A reviewer asking for `bash`, `edit`, or `write` fails at startup.

Resolved models, tools, prompts, and shared text land in `state.json` at start. `resume` reuses that snapshot even if the source files change or disappear. No discovery, inheritance, or template language.

The runner prints its run directory before starting work. It sits beside the source repository:

```text
../.pi-issue-loops/project-123-<timestamp>-<id>/
  state.json
  summary.md
  worktree/
  sessions/
  logs/
  review.patch
  pr.md
```

The original checkout is untouched and its uncommitted work excluded. The feature branch starts from the remote default branch fetched at launch. Branch, worktree, and run files survive success or failure.

## What runs

1. Snapshot the parent and open direct child bodies, plus native dependencies. Sub-issue order survives API pagination; dependencies pick the next eligible ticket. Closed children stay out.
2. Implement one eligible ticket in a fresh session, then run the configured checks outside the agent.
3. Stage the patch, new files included, and start a fresh read-only reviewer with requirements, patch, and check log. The verdict must be strict JSON. Anything else cannot pass.
4. Commit accepted work and record its SHA. At most two implementation repairs per ticket, and two more for the final parent review. A ticket whose requirements already hold passes without a new commit; its checkpoint records the existing HEAD.
5. Push only the feature branch and open one PR. A publication retry looks for the existing PR before creating one.

The controller never merges. Issues stay open until a human merges the final PR, whose body references the parent and accepted children for closing. Internal dependencies resolve through acceptance on the run's branch, not GitHub closure. External blockers must be closed with their implementation already in the pinned base. The runner never rebases. If tickets remain but none can run, it stops instead of declaring victory.

## Resume after a failure or manual fix

Read `summary.md` for statuses, commits, repair counts, the failure and findings, paths, sessions, and the exact resume command.

Fix manually **in the run's worktree**, never in the original checkout. Then:

```sh
pnpm issue-loop resume /absolute/path/to/.pi-issue-loops/project-123-<timestamp>-<id>
```

Resume checks and reviews the current ticket's files before launching another implementer. It keeps your edits, stays on the branch, skips accepted tickets, and never assumes your fix is right. Manual commits are fine mid-ticket or mid-review if they descend from accepted history. They get reviewed too. Never rewrite accepted commits or switch branches.

Budgets persist, so resuming an exhausted ticket buys no fresh repairs. Fix the rest by hand and resume again. Timeouts, provider failures, blocked reviews, and invalid verdicts stop at once. If publication failed and you then edit the worktree, resume rechecks before publishing. If the PR already exists from before a connection failure, resume reuses it. Resuming a completed run just reports the PR.

`state.json` rules. `summary.md` is generated from it, not a plan you can edit. Never hand-edit statuses, reset counters, or move the run directory. GitHub edits do not flow into an existing snapshot.

Version 3 adds the worker settings snapshot. Version 2 predates `--settings`. Version 1 mixed comments into requirements without provenance. None of the old versions resume. Preserve any work, reread the issue bodies, and start fresh. Never bump the version field by hand.

A kill or crash can leave `run.lock` behind. The runner will not guess whether an orphan worker is still writing. Check the recorded controller PID and any Pi/check processes, stop them, inspect the worktree, delete that run's lock, and resume. Normal failures clear the lock themselves.

## Find or reopen worker sessions

Sessions carry a stable run prefix, ticket or parent, role, and attempt number:

```text
loop/owner/project/123-<timestamp>-<id> · #124 implement · attempt 1
loop/owner/project/123-<timestamp>-<id> · #124 review · attempt 1
loop/owner/project/123-<timestamp>-<id> · parent review · attempt 1
```

Explicit `--name` values stop this workspace's `session-auto-name` extension from renaming them. Names and session paths are recorded before Pi launches, failed attempts included. The summary has the exact commands. You can also use:

```sh
cd /path/to/run/worktree
pi --session-dir /path/to/run/sessions --resume
# Or open a specific session:
pi --session /path/to/run/sessions/1-124-implement.jsonl
```

A session file may be missing if Pi died before its first persisted response. The log and planned name still identify the attempt. Touch sessions only while the controller is stopped. Automatic continuation always starts fresh with the saved requirements and latest findings.

## Trust and deliberate limits

This command authorizes controller-owned commits, branch pushes, and PR creation outside Pi's bash permission extension. Worker extensions stay enabled, but workers are told not to commit or touch GitHub, and the reviewer gets no bash, edit, or write tools. The implementer can run bash and edit files.

Skipping comments shrinks unsolicited input, but issue bodies remain untrusted. Prompts plus a worktree are not a sandbox. Run only against repos, dependencies, bodies, and extensions you trust. Setup and check commands run with your privileges. Git hooks stay enabled, and anything a hook changes stops acceptance for rechecking.

No parallel tickets, recursive planning, per-ticket PRs, live pane management, daemons, remote recovery, or automatic merge. Host the controller in Herdr if you like. Output names the current worker and check command. Full output lives in the run's logs.

## Verification

```sh
pnpm exec vitest run packages/issue-loop/cli.test.ts
pnpm typecheck
```

Tests drive the public start/resume commands against temporary Git worktrees and fake Pi/GitHub executables. No models, no GitHub mutations. Model quality and a first live run still want human supervision.
