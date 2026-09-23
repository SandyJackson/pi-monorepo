# GitHub issue loop

A small local controller for one parent GitHub issue. It implements direct child tickets sequentially on one feature branch, runs your checks and independent Pi reviews, and opens one final PR. No workflow engine or Pi extension is required.

## Requirements

- macOS or Linux; Node 22.18+ or Node 24+.
- `git`, authenticated `gh`, and authenticated `pi` on PATH. Pi must support `-p`, `--name`, `--session`, `--approve`, and tool allowlists. Developed against installed Pi 0.86.1.
- A GitHub.com repository with `origin` pointing at the repository containing the parent issue. Fetch and push URLs must be the same. The runner resolves GitHub identity explicitly from `origin`, not from `GH_REPO`.
- Open, implementation-ready direct child issues linked through GitHub's native sub-issue feature. Native blocked-by dependencies are respected. Task-list links in an issue body are not parsed.
- A check command that terminates and exits nonzero on failure. No watch mode.

Both roles use your configured Pi model. Pi resources are loaded for the new worktree using `--approve`. This trusts project-local resources; it does not bypass your command permission extension. Configure Pi authentication before starting so workers do not need an interactive login.

## Start

From this workspace:

```sh
pnpm issue-loop start \
  --repo /absolute/path/to/project \
  --issue 123 \
  --setup 'pnpm install --frozen-lockfile' \
  --check 'pnpm typecheck && pnpm exec vitest run'
```

Or call the runner by absolute path from any directory:

```sh
node /path/to/pi-monorepo/packages/issue-loop/run.mjs start \
  --repo /absolute/path/to/project \
  --issue 123 \
  --check 'make test'
```

`--setup` is optional. A new Git worktree does not inherit untracked dependencies such as `node_modules`; provide setup when needed. It runs before the first ticket and runs again if a failed setup is explicitly resumed, so use a repeatable command.

`--timeout SECONDS` limits each worker, setup, and check invocation. It defaults to 1800 and accepts 1–7200. Git/GitHub operations have a 60-second limit. Ctrl-C stops the active process group, preserves work, and records a blocked run. A repeated interrupt escalates to SIGKILL.

The runner prints its run directory before starting work. It lives beside the source repository:

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

The original checkout is not switched, cleaned, or copied. Uncommitted work there is not included. The new feature branch starts from the remote default branch fetched at launch. The branch/worktree and run files are retained after success or failure.

## What runs

1. Snapshot the parent, open direct child issues, their comments, and native dependencies. Numeric issue order breaks ties between eligible tickets. Closed children are outside this run's queue.
2. Start a fresh implementation session for one eligible ticket.
3. Run the configured checks outside the agent.
4. Stage the patch, including new files, and start a fresh read-only reviewer with the requirements, patch, and check log. A strict JSON verdict is required. Invalid output cannot pass.
5. Commit accepted work and record its SHA. If checks or review request changes, allow at most two implementation repairs for that ticket.
6. Once tickets are accepted, run checks and review the cumulative change against the parent specification. This phase also has at most two repairs.
7. Push only the feature branch and open one PR. A publication retry checks for an existing PR instead of creating a duplicate.

The controller never merges. Issues remain open until a human merges the final PR into the default branch; its body includes closing references for the parent and accepted children.

Internal dependencies are satisfied by ticket acceptance on this run's branch, not GitHub closure. External blockers must be closed. Make sure their implementation is present in the pinned base before starting; the runner does not automatically update or rebase its worktree when another issue is resolved. If there are unfinished tickets but none can run, it stops instead of claiming completion.

A ticket may be accepted without a new commit if its requirements are already satisfied and checks/review pass. Its checkpoint then records the existing HEAD.

## Resume after a failure or manual fix

Read `summary.md`. It lists ticket statuses, accepted commits, repair counts, the current failure/findings, worktree path, sessions, and an exact resume command.

Make any manual fix **in the run's worktree**, not in the original checkout. Then:

```sh
pnpm issue-loop resume /absolute/path/to/.pi-issue-loops/project-123-<timestamp>-<id>
```

Resume checks and reviews the current ticket's files before launching another implementation worker. It does not throw away your edits, reset the branch, rerun accepted tickets, or assume your fix is correct. Manual commits are allowed during an interrupted ticket or final review as long as they descend from accepted history; they are reviewed too. Do not rewrite accepted commits or change the branch.

Repair budgets are persisted. Resuming an exhausted ticket permits checking and reviewing a manual fix, but does not buy two more automatic repairs. Fix any remaining findings manually and resume again. Timeouts, provider failures, blocked reviews, and invalid verdicts stop immediately rather than consuming repeated attempts automatically.

If publication failed and you subsequently edit the worktree, resume repeats the final checks/review before publishing those edits. If the PR was already created before a connection failure, resume reuses it. Resuming a completed run just reports the existing PR.

`state.json` is authoritative. `summary.md` is generated from it, not a second editable plan. Do not hand-edit statuses, reset repair counters, or move the run directory. Issue/spec changes on GitHub are not automatically imported into an existing snapshot.

An abrupt kill or machine crash can leave `run.lock`. The runner deliberately does not guess whether an orphan worker is still writing files. Check the recorded controller PID and any Pi/check processes, stop them, inspect the worktree, then remove that run's lock file and resume. Normal failure/interrupt removes the lock automatically.

## Find or reopen worker sessions

Every session has a stable run prefix, ticket or parent, role, and monotonically increasing attempt number:

```text
loop/owner/project/123-<timestamp>-<id> · #124 implement · attempt 1
loop/owner/project/123-<timestamp>-<id> · #124 review · attempt 1
loop/owner/project/123-<timestamp>-<id> · parent review · attempt 1
```

Explicit `--name` values prevent this workspace's `session-auto-name` extension from naming them. No extension changes are needed. The runner records each name and session path before launching Pi, including failed attempts.

The summary contains exact commands. You can also use:

```sh
cd /path/to/run/worktree
pi --session-dir /path/to/run/sessions --resume
# Or open a specific session:
pi --session /path/to/run/sessions/1-124-implement.jsonl
```

A session file may not exist if Pi failed before persisting its first assistant response; the log and planned session name still identify the attempt. Only inspect or manually continue sessions while the controller is stopped. Automatic continuation always uses a fresh worker session with the saved requirements and latest findings.

## Trust and deliberate limits

Invoking this command authorizes controller-owned commits, feature-branch pushes, and final PR creation. These happen outside Pi's bash permission extension. Worker extensions remain enabled; workers are instructed not to commit or mutate GitHub. A read-only reviewer has no bash/edit/write tools.

The implementation worker can execute bash and edit files. Prompts and a worktree are not a security sandbox. Only run against trusted repositories, dependencies, issues, and project extensions. The setup/check commands execute with your privileges. Git hooks remain enabled; changes made by a commit hook cause acceptance to stop for rechecking.

There is no parallel ticket execution, recursive planning, per-ticket PR, live worker pane management, daemon, remote recovery service, or automatic merge. Use Herdr to host the controller terminal if desired. Output shows the current worker and check command; full output is in the run's logs.

## Verification

```sh
pnpm exec vitest run packages/issue-loop/cli.test.ts
pnpm typecheck
```

Tests invoke the public start/resume commands with real temporary Git worktrees and fake Pi/GitHub executables. They do not call models or mutate GitHub. Actual model quality and a first live run still need human supervision.
