# GitHub issue loop

A small local controller for one parent GitHub issue. It implements direct child tickets one by one on a single feature branch, runs your checks and independent Pi reviews, and opens one final PR. No workflow engine or Pi extension is required.

## Requirements

- macOS or Linux; Node 22.18+ or Node 24+.
- `git`, authenticated `gh`, and authenticated `pi` on PATH. Pi must be 0.99.1 or newer and support RPC mode (`--mode rpc`), `--name`, `--session`, `--approve`, `--no-extensions`, and tool allowlists. The controller preflights the installed version before launching any worker.
- A GitHub.com repository with `origin` pointing at the repo holding the parent issue. Fetch and push URLs must match. GitHub identity comes from `origin`, not `GH_REPO`.
- Open, implementation-ready child issues linked through GitHub's native sub-issue feature. Native blocked-by dependencies are respected. Task-list links are ignored.
- Requirements live in the parent and ticket bodies. Comments are never fetched or forwarded, so copy approved decisions into the relevant body before starting.
- A check command that terminates and exits nonzero on failure. No watch mode.

Worker models and thinking levels are resolved per role at start, from the defaults or `--settings`. Fresh implementation conversations use the implement role's model/thinking; fresh child and advisory reviews use the review role's model/thinking; and a repair reopens the originating conversation and preserves its model/thinking. The new worktree loads Pi resources with `--approve`, which trusts project-local resources without bypassing your command permission extension. Ambient extensions are disabled for every worker (`--no-extensions`); only the curated loop skills you select are loaded. Authenticate Pi first so workers never face an interactive login.

Workers run through Pi's supervised RPC mode, so the controller correlates commands, waits for the settled run, and reads the authoritative final message rather than inferring completion from free text. Pi's own provider retries stay enabled and do not consume the controller's repair rounds.

## Operator workflow

1. `start` a run against a parent issue. The controller prints its run directory and works through the children on one feature branch.
2. Follow `summary.md` or the console. Each child is implemented, checked, committed, and independently reviewed. Findings are repaired in the reviewer's conversation, then a fresh reviewer assesses the result.
3. If the run stops, read `summary.md`, fix or finish the work in the run worktree, and `resume` (see [Resume after a failure or manual fix](#resume-after-a-failure-or-manual-fix)).
4. Once every child is accepted and the required checks pass, the controller pushes the branch, opens one PR, and posts an advisory whole-artifact review as a PR comment.
5. Review the PR yourself. It keeps each child's feature commit and `fixup!` repairs. Squashing, autosquashing, merging, and any further changes are yours to decide; the controller never merges, rebases, or repairs the PR.

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

`--timeout SECONDS` overrides the controller-owned setup and check command deadlines (default 3600, accepts 300-7200). Worker supervision uses the watchdog policy in the settings snapshot instead; its default hard ceiling is two hours, with a ten-minute silence threshold and a thirty-minute per-tool cap. Git/GitHub operations get 60 seconds. Ctrl-C stops the active process group, preserves work, and records a blocked run. A second interrupt escalates to SIGKILL. Controller commands wait for process-group cleanup before returning, including when the leader exits before its descendants; surviving processes receive SIGKILL after two seconds.

## Customizing workers

`--settings ./loop-settings.json` overrides worker models, thinking levels, tool allowlists, role guidance, and a shared system-prompt addition. Every field is optional.

```json
{
  "implementAgent": "./agents/loop-implement.md",
  "repairAgent": "./agents/loop-repair.md",
  "reviewAgent": "./agents/loop-reviewer.md",
  "implementSkills": ["tdd"],
  "repairSkills": ["tdd", "diagnosing-bugs", "deslop"],
  "reviewSkills": [],
  "repairRounds": 3,
  "watchdog": {
    "silenceMs": 600000,
    "toolMs": 1800000,
    "softCheckpointMs": 3600000,
    "checkpointGraceMs": 300000,
    "hardCeilingMs": 7200000,
    "abortGraceMs": 10000,
    "sigkillEscalationMs": 2000
  },
  "recovery": { "transientRetries": 2, "transientBackoffMs": [5000, 15000] },
  "deadlines": { "setupMs": 3600000, "checkMs": 3600000, "gitMs": 60000 },
  "appendSystemPrompt": "Prefer small, focused changes."
}
```

Every field is optional. `repairRounds`, `watchdog`, `recovery`, and `deadlines` override individual values; [Supervision, recovery, and budgets](#supervision-recovery-and-budgets) lists the defaults.

Same-conversation repair appends the transition guidance, repair skills, and additive editing tools to the reviewer's existing conversation, so the diagnosis, earlier messages, model/thinking, and initial definitions stay in place. `repairAgent` supplies repair prompt guidance and additive tools, and `repairSkills` supplies additive skills. The `repairAgent` model and thinking values do not replace the originating conversation's values; a repair never starts on a separately selected model. That inheritance is intentional: it preserves context and keeps the prefix eligible for provider cache reuse. Provider cache reuse is best-effort: where a provider or configuration cannot encode additive tool definitions, the same-session repair still runs but the prefix may miss the cache. See [Verification](#verification) for what offline tests can and cannot show.

Agent files use the agent markdown format: frontmatter with `model`, `thinking`, and `tools`, plus a prompt body that replaces the default role guidance only. `thinking` accepts one of Pi's levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); omitting it keeps Pi's default, while `off` disables thinking. Paths resolve relative to the settings file. The runner still supplies issue context, constraints, patch/check context, and the reviewer's required structured outcome format.

Without `--settings`, the roles use the blessed files in `agents/` (`loop-implement.md`, `loop-repair.md`, `loop-reviewer.md`); implement and repair get the curated trio `tdd`, `diagnosing-bugs`, `deslop`, and review gets none. A settings file replaces one or more role files — the blessed files double as the template for user-authored replacements. Omitting `implementSkills`/`repairSkills` keeps the trio and omitting `reviewSkills` keeps empty; an explicit list (including `[]`) replaces the default.

Workers always start with `--no-skills`: they never inherit ambient workspace or user skills. `implementSkills` / `reviewSkills` name curated loop skills by short name (closed set, from `packages/issue-loop/loop-skills/`; currently `tdd`, `deslop`, `diagnosing-bugs`). The reviewer default stays empty. At `start` the controller copies the selected skills into `<run>/skills/` and workers load them via `--skill`; `resume` reuses the copy.

Blessed role files ship with the package and can be referenced from your settings file (paths resolve relative to it):

- `agents/loop-implement.md` — implement worker: reaches for `/skill:tdd`, `/skill:diagnosing-bugs`, and `/skill:deslop` explicitly, with ponytail simplicity tags (`delete/stdlib/native/yagni/shrink`) baked in.
- `agents/loop-repair.md` — repair worker: keeps the reviewer's diagnosis, edits only what the findings require, and retracts a wrong finding instead of manufacturing a change.
- `agents/loop-reviewer.md` — review worker: single-pass Standards + Spec review condensed from the code-review skill and code-reviewer agent, ending in the required structured outcome.

```json
{
  "implementAgent": "<path-to-pi-monorepo>/packages/issue-loop/agents/loop-implement.md",
  "reviewAgent": "<path-to-pi-monorepo>/packages/issue-loop/agents/loop-reviewer.md",
  "implementSkills": ["tdd", "diagnosing-bugs", "deslop"]
}
```

An absent `tools` field keeps the built-ins (implement: `read,grep,find,ls,bash,edit,write`; review: `read,grep,find,ls`). An explicit list replaces them. A reviewer asking for `bash`, `edit`, or `write` fails at startup.

Resolved models, tools, prompts, and shared text land in `state.json` at start. `resume` reuses that snapshot even if the source files change or disappear. Repairs keep the originating conversation's model/thinking (see above). There is no discovery or template language.

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
  review-observations.md
```

The original checkout is untouched and its uncommitted work excluded. The feature branch starts from the remote default branch fetched at launch. Branch, worktree, and run files survive success or failure.

## What runs

1. Snapshot the parent and open direct child bodies, plus native dependencies. Sub-issue order survives API pagination; dependencies pick the next eligible ticket. Closed children stay out.
2. Implement one eligible ticket in a fresh session.
3. Run configured checks, then create the work commit with normal hooks, then start a fresh read-only reviewer with requirements, the cumulative child patch since the original baseline, and the check log. The first changed work commit is the child's feature anchor; later changed repairs are standard `fixup!` commits targeting it. Controller commits keep their readable feature/fixup subject and carry stable `Loop-Run`/`Loop-Step` trailers. The reviewer returns a structured outcome: `pass` (no critical or major finding), `changes_requested` (at least one critical or major finding), or `incomplete`/`blocked`. Findings carry axis, severity, location, and description; the controller assigns their identities and reviewed-artifact reference. A pass cannot carry material findings. A clean hook mutation is rechecked before review. An actionable code/test/lint hook failure returns to the last editing session as repair feedback and spends a code-repair round; a signing/identity/configuration failure preserves the staged work and stops for recovery; a hook that leaves the worktree dirty stops with the work preserved, and an unchanged resume stops again rather than turning the hook's leftovers into a fixup. Hooks are never bypassed. An interrupted editing phase's saved files stay uncommitted and are reviewed as HEAD plus the content tree, so resuming unchanged never manufactures a work commit. The commit intent is persisted before Git runs, so a crash between the commit and the state save is reconciled on resume from its verified parent lineage, content tree, and trailers; a provable commit is recorded once without duplication, and an ambiguous one blocks with diagnostics and preserved work.
4. When that assessment passes and the child has an earlier `changes_requested` verdict, the controller runs one read-only audit in the same reviewer conversation and the same phase-task budget. The audit receives only the latest failed verdict's findings and the intervening repair/retraction explanation, and must pass on the unchanged artifact before acceptance. A `changes_requested` verdict persists the findings, then closes the settled review process and reopens the same session with the dedicated repair guidance/skills and additive editing tools. The repair keeps the conversation's model, thinking, and cached prefix; a fresh independent reviewer then assesses the changed artifact. A failed required check returns to the last editing conversation and spends one code-repair round. A no-change retraction records its explanation, spends one round, and is reviewed independently. At most three configurable code-repair rounds per child (including check failures and retractions), then the child stops with the findings preserved.
5. Record the accepted SHA separately from the work commits, and retain each earlier artifact-linked verdict alongside the latest so a repair cannot erase the assessment it answered. The reviewer never edits, and the controller guards the branch, HEAD, index, and worktree (including relevant untracked files) before and after review, so a changed artifact can never be accepted with an old verdict.
6. Publication gate. Once every child is accepted, the controller runs the configured checks against the aggregate artifact and refuses to publish an uncommitted or failing worktree. A failed gate blocks with the work preserved; the controller never commits parent integration work or introduces parent fixup anchors.
7. Push only the feature branch and open one PR with its unsquashed feature/fixup history. Only after the PR exists does a fresh read-only reviewer assess the parent requirements, every child, and the whole cumulative artifact. The advisory verdict is posted as a marked PR comment with its findings, summary, and reviewed HEAD/content-tree IDs. Passing ticket observations from earlier reviews also appear in the comment as historical notes, not a reconciled outstanding-issues list; later changes may resolve them. Reviewer text never goes into the PR description, where closing keywords could affect issue closure. Material findings do not trigger automatic parent repairs or block completion. Publication retries reuse the PR and update the owning author's managed observations section. The PR description, other authors' comments, and human text outside the section are preserved. Ambiguous or damaged section markers stop publication for inspection. Warnings, staleness, and resume behavior are described in [Advisory warnings and staleness](#advisory-warnings-and-staleness).

### Phase outcomes

Workers must end each phase with a structured outcome that is valid for that phase:

| Phase | Outcome | Effect |
|---|---|---|
| Implement, repair | `complete` | Checks run, then the work commit. |
| Implement, repair | `incomplete` | One same-session continuation; a second stops the phase. |
| Implement, repair | `blocked` | The child stops with the blockers recorded. |
| Review, audit | `pass` | No critical or major finding. Accepts the child, after the audit when an earlier verdict requested changes. |
| Review, audit | `changes_requested` | At least one critical or major finding. The same conversation becomes the repair. |
| Review, audit | `incomplete` / `blocked` | One continuation for `incomplete`; otherwise the child stops. |

A malformed outcome, one that is not valid for the phase, or a `pass` after failed required checks gets one same-session correction.

The controller never merges. Issues stay open until a human merges the final PR, whose body references the parent and accepted children for closing. Internal dependencies resolve through acceptance on the run's branch, not GitHub closure. External blockers must be closed with their implementation already in the pinned base. The runner never rebases. If tickets remain but none can run, it stops instead of declaring victory.

## Supervision, recovery, and budgets

The effective settings are snapshotted into `state.json` at start. Budgets are separate and none of them replenish across resume:

| Budget | Default | Spent on |
|---|---|---|
| Code-repair rounds (`repairRounds`) | 3 per child | Repairs after `changes_requested`, failed required checks, actionable hook failures, and no-change retractions |
| Pi native retries | Pi's own policy | Provider errors Pi retries itself; never charged to the controller |
| Controller transient retries (`recovery.transientRetries`) | 2, after 5 s then 15 s (`transientBackoffMs`) | A known transient provider failure after Pi reports its retries exhausted |
| Response corrections | 1 | A malformed or phase-inconsistent outcome |
| Continuation | 1 per phase task | One `incomplete` outcome per phase task, whether voluntary or returned after a checkpoint |

Watchdog limits (`watchdog`) and controller command deadlines (`deadlines`):

| Setting | Default | Meaning |
|---|---|---|
| `silenceMs` | 10 min | No observable model or tool progress requests a checkpoint |
| `toolMs` | 30 min | One tool call running this long requests a checkpoint |
| `softCheckpointMs` | 60 min | A productive phase this long requests a soft checkpoint |
| `checkpointGraceMs` | 5 min | Time to answer a checkpoint before abort |
| `hardCeilingMs` | 120 min | Whole phase task, including retries, backoff, and the continuation |
| `abortGraceMs` | 10 s | Time to settle after abort before the process group is terminated |
| `sigkillEscalationMs` | 2 s | SIGTERM to SIGKILL escalation |
| `setupMs`, `checkMs` | 60 min | Setup and required-check commands (`--timeout` overrides both) |
| `gitMs` | 60 s | Each Git/GitHub operation |

The watchdog is enforced by the supervised worker: ten minutes without observable model or tool progress (tracked per in-flight tool, so one call cannot hide another), or a single tool running for thirty minutes, requests one structured checkpoint; a sixty-minute phase requests a soft checkpoint. A checkpoint asks the worker to return a structured outcome and does not itself spend the continuation. An `incomplete` outcome, voluntary or returned at a checkpoint, consumes the one same-session continuation and starts another turn; `complete`, `pass`, or `changes_requested` finishes the phase task normally, and `blocked` stops it. A second `incomplete` stops the phase. If the worker does not answer within the five-minute checkpoint grace, the controller clears queued messages, aborts, and terminates the process group within the ten-second abort grace and two-second SIGKILL escalation. The 120-minute hard ceiling covers retries and the continuation. Consumed runtime, continuation state, and the checkpoint evidence survive resume and are replayed to the resumed attempt; runtime is flushed on every exit and periodically so a controller crash cannot replenish the allowance.

Recovery is bounded and durable. Pi's own provider retries stay enabled and are never charged to the controller. Only after Pi reports its native retries exhausted (`auto_retry_end` with `success: false`) does the controlled worker classify the recorded `finalError` and, for a known transient provider failure, spend one of the `transientRetries` (default 2) after the matching `transientBackoffMs` (default five then fifteen seconds), replaying the recorded failure and warning against repeating a failed command blindly. A cancelled retry, a provider billing/quota limit, and any unrecognized error are not retried. A malformed or phase-inconsistent response, including a `pass` after failed required checks, gets one same-session correction attempt. Transient retries, corrections, the incomplete/stalled continuation, and child repair rounds are separate counters; none of them replenish across resume, and backoff still counts against the hard ceiling. An unclassified exit, user interruption, authentication/configuration failure, or Git invariant violation is never retried.

## Resume after a failure or manual fix

Read `summary.md` for statuses, commits, repair counts, the failure, historical review observations, paths, sessions, and the exact resume command.

Fix manually **in the run's worktree**, never in the original checkout. Then:

```sh
pnpm issue-loop resume /absolute/path/to/.pi-issue-loops/project-123-<timestamp>-<id>
```

Resume keeps your edits, stays on the branch, skips accepted tickets, and never assumes your fix is right:

- Uncommitted files or commits on the current ticket are checked, then assessed by a fresh reviewer with the whole changed artifact and any check failure, even when checks still fail. That reviewer becomes the repairer if it requests changes; the stale editor is never reopened.
- An interrupted phase with no operator change resumes its own conversation and phase task, keeping consumed runtime and every budget. A repair that saved files and then failed is execution recovery, not another repair round.
- A cached passing review is revalidated against the current required checks before acceptance.
- A commit interrupted between Git and the state save is reconciled from its parent lineage, content tree, and `Loop-Run`/`Loop-Step` trailers. A provable commit is recorded once; an ambiguous one stops with diagnostics and the work preserved.

Budgets persist, so resuming an exhausted ticket buys no fresh repairs. Fix the rest by hand and resume again. Exhausted budgets, unrecognized provider failures, `blocked` outcomes, and a failed correction stop the run. If publication failed and you then edit the worktree, resume rechecks before publishing; commit the change in the run worktree so the publication artifact is clean, because an uncommitted tree is refused rather than turned into a controller commit. Resuming a completed run just reports the PR.

`state.json` rules. `summary.md` is generated from it, not a plan you can edit. Never hand-edit statuses, reset counters, or move the run directory. GitHub edits do not flow into an existing snapshot.

A kill or crash can leave `run.lock` behind. The runner will not guess whether an orphan worker is still writing. Check the recorded controller PID and any Pi/check processes, stop them, inspect the worktree, delete that run's lock, and resume. Normal failures clear the lock themselves.

### Manual commits

Manual commits are fine mid-ticket or mid-review if they descend from accepted history; they get reviewed too. A single manual commit that the controller never recorded becomes the child's feature anchor with its origin recorded, so later repairs are standard fixups of your commit and its subject and history are left untouched. Several manual commits since the baseline have no unambiguous anchor: the run stops for you to leave exactly one ticket-scoped commit rather than guessing which one future fixups should target. Never rewrite accepted commits or switch branches; a resume that no longer descends from accepted history stops with the work preserved.

### Hook failures

Git hooks always run and are never bypassed. A clean hook mutation is rechecked before review. A recognized code, test, lint, or formatting failure (including a failed recheck) returns to the last editing conversation as repair feedback and spends a code-repair round. A signing, identity, or configuration failure, a tooling or unrecognized failure, and a hook that leaves the worktree dirty all preserve the staged work and stop. Fix the cause in the run worktree or your Git configuration, then resume. A dirty hook's leftovers are never turned into a fixup, so an unchanged resume stops again.

### Advisory warnings and staleness

The advisory review never blocks the PR, but the run reports a `Warning:` on stderr, in `summary.md`, and in the PR comment when:

- the review was unavailable: execution failed after bounded recovery, or the worktree changed after publication or during the review. No assessment is presented for a mixed-version read.
- the review finished `incomplete` or `blocked`.
- the remote branch advanced past the reviewed SHA. The findings stay attached to the SHA they describe and are labelled stale.

These outcomes persist. Resume republishes the recorded warning or findings instead of running another review. The PR is found again by its branch, and the comment by its hidden marker, recorded ID, and owning login; an account change or a missing recorded comment stops rather than posting a duplicate.

### Old run state

Run state is versioned and older versions never resume. `resume` refuses an older `state.json` before taking the run lock or launching a worker, and leaves the state file, worktree, branch, and sessions exactly as they were. Preserve any work from that worktree, reread the issue bodies, and start a new run. Never bump the version field by hand.

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

A session file may be missing if Pi died before its first persisted response. The log and planned name still identify the attempt. Touch sessions only while the controller is stopped. Implementation and every independent review start a fresh session. A repair is a new Pi process on its reviewer's session file, with the repair guidance and editing tools added, and an interrupted phase resumes its own session. Manual changes always get a fresh reviewer rather than the stale editor.

## Trust and deliberate limits

This command authorizes controller-owned commits, branch pushes, and PR creation outside Pi's bash permission extension. Workers run with ambient extensions and skills disabled and are told not to commit or touch GitHub; the reviewer gets no bash, edit, or write tools. The implementer can run bash and edit files. Only the curated loop skills named in the settings are loaded.

Skipping comments shrinks unsolicited input, but issue bodies remain untrusted. Prompts plus a worktree are not a sandbox. Run only against repos, dependencies, bodies, and extensions you trust. Setup and check commands run with your privileges. Git hooks stay enabled and are never bypassed; a clean mutation is rechecked before review, a recognized code/test/lint failure (including a failed recheck) returns to the last editing session, and a signing/configuration, tooling, or unrecognized failure or dirty hook preserves work and stops.

No parallel tickets, recursive planning, per-ticket PRs, live pane management, daemons, remote recovery, or automatic merge. Host the controller in Herdr if you like. Output names the current worker and check command. Full output lives in the run's logs.

## Verification

Run the checks cheapest first, so a lint or type error fails in seconds rather than after the two-minute suite:

```sh
pnpm lint
pnpm typecheck
pnpm exec vitest run
```

The full suite includes the issue-loop tests. While iterating, `pnpm exec vitest run packages/issue-loop/cli.test.ts -t "<name>"` runs a single scenario; the whole package is nearly as slow as the full suite.

Tests drive the public `start`/`resume` commands against temporary Git worktrees and fake Pi/GitHub executables: no models, no GitHub mutations, no provider credits. Watchdog, backoff, and grace timing use a virtual clock in the worker tests; CLI tests use short deadlines and synchronize on fixture events rather than long sleeps.

An opt-in offline smoke checks the installed Pi:

```sh
ISSUE_LOOP_PI_SMOKE=1 pnpm exec vitest run packages/issue-loop/pi.smoke.test.ts
```

It runs the controller's version preflight, starts Pi in worker RPC mode with extensions and skills disabled, checks correlated LF-framed `get_state`/`get_messages` responses for the requested session path and name, and requires a clean exit when stdin closes. It sends no prompt, so no model or provider is called. It is skipped by default because the result depends on the local Pi install.

Limits: fixture and offline tests verify same-session construction and reuse, not provider cache hits; cache reuse depends on the provider and is best-effort. No paid end-to-end smoke is included or authorized. Model quality and a first live run still want human supervision.
