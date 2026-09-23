# A GitHub issue implementation loop for Pi

Research date: 2026-09-23. This note records the research before implementation.

Following the design discussion, the MVP was implemented in [`packages/issue-loop`](../../packages/issue-loop/README.md). It uses a dependency-free Node controller, durable ticket state and repair counts, a generated handoff summary, explicit resume, and named Pi sessions. Following PR review, issue comments are omitted from worker inputs and parent sub-issue order is preserved. See that README for the implemented behaviour and limitations.

## Decision to make

The user wants to implement a parent GitHub issue through its child tickets, with separate Pi implementer and reviewer sessions. Tickets run sequentially, with automatic progression after checks and review. All work accumulates on one feature branch, and the user reviews one final PR. No per-ticket PRs or routine human approval gates. Blockers must stop the run.

Priority: time to a usable first feature, not a general-purpose orchestration system.

Recommendation: start with a small external runner invoking `pi -p`, `gh`, and the repository's check commands. Use one dedicated worktree, fresh sessions, bounded repair attempts, and a small checkpoint file. Run it in a Herdr pane, but do not make Herdr agent-state detection the acceptance gate. If durable recovery or interactive takeover is necessary immediately, use `pi-extensible-workflows` instead. Do not choose `pi-workflows` for this particular first version.

These are design recommendations, not results from running an implementation. Three research subagents inspected the supplied repositories and local Pi source/docs. The parent agent checked key source findings, GitHub documentation, and the local bash policy. No package was installed or workflow executed end to end.

## Sources inspected

| Source | Version inspected |
| --- | --- |
| Matt Pocock's workshop | [`2f36ec7`](https://github.com/mattpocock/ralph-workshop-repo-001/tree/2f36ec7e4d0c86ff76bbfb61b261a9572c50eb3e) |
| `pi-extensible-workflows` | [`0c11e34`](https://github.com/vekexasia/pi-extensible-workflows/tree/0c11e343cc3b36afcc702a334a0c47ce0b27d622), package 5.16.1 |
| `pi-workflows` | [`bf32dc5`](https://github.com/osolmaz/pi-workflows/tree/bf32dc561f210ed8dfa2a4340afb92be7e8abd92), package 0.17.4 |
| Pi | Installed `@earendil-works/pi-coding-agent` 0.86.1, README, relevant docs, and compiled print-mode source |
| GitHub | Official sub-issue, dependency, and issue-closing documentation |
| Local workspace | `CONTEXT.md`, issue-tracker conventions, relevant ADRs, Herdr skill, and bash-permission source/config |

The local Pi package is under `/opt/homebrew/Cellar/pi-coding-agent/0.86.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/`. Its upstream documentation is at [earendil-works/pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Local version-specific observations below should be rechecked on upgrade.

## Comparison

### 1. A small runner around Pi CLI calls

The controller chooses the next eligible ticket, invokes a fresh implementer, runs fixed check commands, invokes a fresh reviewer, and decides whether to accept, retry, or stop. Those transitions are ordinary code. The model does not choose the queue or declare the whole parent complete by itself.

Advantages:

- Direct fit for one branch, sequential tickets, independent review, and one final PR.
- No new workflow engine, database, server, or SDK integration.
- Separate `pi -p` processes naturally provide separate sessions and allow different models per role.
- Easy to inspect the queue, prompts, checks, and stop conditions.
- The GitHub adapter and prompts can be reused if an engine is adopted later.

Costs:

- The runner owns timeout handling, strict verdict parsing, checkpointing, and partial-run recovery.
- Logs and saved sessions are less convenient than a live per-agent workflow viewer.
- A shell script becomes awkward if it grows into a generic scheduler. Keep it specific to this ticket protocol.

Use bash plus `gh` and `jq` initially if the logic stays small. A single Node script is reasonable if JSON and subprocess handling become cumbersome; this does not require adopting Pi's SDK or writing an extension.

Pi supports print/JSON/RPC modes, named saved sessions, tool allowlists, and per-invocation model selection. See the [Pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

### 2. `pi-extensible-workflows`

This is the closest packaged fit. Its bundled [`reviewLoop`](https://github.com/vekexasia/pi-extensible-workflows/blob/0c11e343cc3b36afcc702a334a0c47ce0b27d622/packages/core/starter/review-loop.ts) runs separate developer and reviewer agents, obtains a structured `pass`/`findings` verdict, and stops after a bounded number of iterations. Each normal `agent()` call creates a fresh session. Roles control models, tools, and resources. See [agent execution](https://github.com/vekexasia/pi-extensible-workflows/blob/0c11e343cc3b36afcc702a334a0c47ce0b27d622/packages/core/src/agent-execution.ts).

Advantages:

- Existing implement/review structure and structured output validation.
- Journaled operations and retry/replay support rather than hand-written recovery.
- Worktree support, run inspection, and an optional [Herdr companion](https://github.com/vekexasia/pi-extensible-workflows/blob/0c11e343cc3b36afcc702a334a0c47ce0b27d622/packages/extensions/herdr/README.md) for live handoff or running agents visibly.
- Clear upgrade option if long unattended runs and recovery become important.

Costs:

- Still needs the parent/sub-issue queue, dependency rules, ticket acceptance tracking, fixed test gates, and final PR logic.
- The bundled review loop does not independently execute the repository's test commands between implement and review. Add that explicitly.
- More concepts to learn: workflow scripts, host operations, roles, settings, journals, and replay semantics.
- Journaled effects are not an exactly-once guarantee across a crash between an external mutation and its journal record. PR creation still needs an existing-PR check.
- Built-in worktree creation requires a clean starting tree and creates from HEAD. Worktrees are retained rather than automatically merged and cleaned.

Sources: [workflow reference](https://github.com/vekexasia/pi-extensible-workflows/blob/0c11e343cc3b36afcc702a334a0c47ce0b27d622/docs/llm.md), [store/worktree implementation](https://github.com/vekexasia/pi-extensible-workflows/blob/0c11e343cc3b36afcc702a334a0c47ce0b27d622/packages/core/src/store.ts), and [repository operating notes](https://github.com/vekexasia/pi-extensible-workflows/blob/0c11e343cc3b36afcc702a334a0c47ce0b27d622/AGENTS.md).

Installation is documented as `pi install npm:pi-extensible-workflows`, with optional `npm:@piewf/herdr`. Node 22.19 or newer is required. Source uses the current `@earendil-works` scope; imported APIs were checked against local Pi 0.86.1, but runtime compatibility was not tested. Pin versions for an initial trial.

### 3. `pi-workflows`

This provides TypeScript workflow graphs, deterministic routing, a SQLite-backed server, durable execution, effect recovery contracts, and Herdr/TUI viewers. Its important distinction is that ordinary agent steps run in the current Pi conversation. They do not automatically create independent implementer/reviewer sessions. See its [README](https://github.com/osolmaz/pi-workflows/blob/bf32dc561f210ed8dfa2a4340afb92be7e8abd92/README.md) and [workflow reference](https://github.com/osolmaz/pi-workflows/blob/bf32dc561f210ed8dfa2a4340afb92be7e8abd92/docs/WORKFLOWS.md).

Advantages:

- Strong explicit state transitions, persistence, pause/resume, and ambiguous-effect handling.
- Live server-owned run views and Herdr integration.
- Includes an `autoimplement` workflow with branch/worktree preparation, external `pi-reviewer` integration, PR handling, and CI follow-up. It is not merely an empty engine.

Costs for this request:

- The standard conversation model differs from the proposed independent-session loop.
- Detached resource-manager children or external Pi invocations can provide isolation, but require additional orchestration. Per-node model selection is not a normal agent-node option at this revision.
- The existing `autoimplement` workflow is not a drop-in parent/sub-issue queue with the user's final-only approval policy.
- Alpha policy allows persisted schema and contract changes that require resetting old state.

Sources: [detached RPC executor](https://github.com/osolmaz/pi-workflows/blob/bf32dc561f210ed8dfa2a4340afb92be7e8abd92/src/server/rpc-executor.ts), [resource managers](https://github.com/osolmaz/pi-workflows/blob/bf32dc561f210ed8dfa2a4340afb92be7e8abd92/docs/RESOURCE_MANAGERS.md), [design philosophy](https://github.com/osolmaz/pi-workflows/blob/bf32dc561f210ed8dfa2a4340afb92be7e8abd92/docs/DESIGN_PHILOSOPHY.md), [alpha policy](https://github.com/osolmaz/pi-workflows/blob/bf32dc561f210ed8dfa2a4340afb92be7e8abd92/AGENTS.md).

Its dependency ranges include local Pi 0.86.1, but no runtime smoke test was performed. Neither extension eliminates the custom GitHub queue logic.

## Is Ralph obsolete?

The useful pattern remains applicable: fresh context, one bounded task, external memory, executable checks, and repetition. A newer workflow engine changes how those steps run, not whether the pattern is useful. This research does not establish which name or approach is currently most popular.

The workshop's [prompt](https://github.com/mattpocock/ralph-workshop-repo-001/blob/2f36ec7e4d0c86ff76bbfb61b261a9572c50eb3e/plans/prompt.md) uses recent `RALPH:` commits as memory, runs checks, and works on one task at a time. Its [unattended script](https://github.com/mattpocock/ralph-workshop-repo-001/blob/2f36ec7e4d0c86ff76bbfb61b261a9572c50eb3e/plans/afk-claude.sh) uses bounded iterations and completion/abort markers. It does not supply this GitHub queue or independent reviewer. Borrow the structure, not the Claude/Docker-specific commands or model-controlled task selection.

For this MVP, code should select the ticket and determine when the queue is exhausted. A model verdict is review evidence, not proof of correctness or a substitute for checks and final human review.

## Proposed MVP

```text
Read parent, tickets, dependencies, and acceptance criteria
Create one dedicated worktree and feature branch
Repeat:
  Choose the first eligible unfinished ticket
  Run a fresh implementer for that ticket
  Run fixed repository checks outside the agent
  Run a fresh reviewer against the ticket and actual patch
  If checks/review fail, attempt bounded fixes and recheck
  If accepted, commit and record the accepted commit
  If blocked or attempts exhausted, stop and preserve work
When all tickets are accepted:
  Run full checks and a fresh parent-spec review
  Push the feature branch and open one final PR
  Stop for the user's review; never merge automatically
```

### Keep queue and completion decisions outside the model

Use `gh api` for [sub-issues](https://docs.github.com/en/rest/issues/sub-issues) and [blocked-by dependencies](https://docs.github.com/en/rest/issues/issue-dependencies), with pagination. Freeze a stable initial ticket order and spec snapshot, respecting dependencies. Prefer the parent's explicit order; otherwise use a documented stable tie-break. A 404, auth failure, or empty unexpected response must not be interpreted as completion.

Start with a flat list of implementation-ready child tickets. Research/grilling tasks or ambiguous requirements stop the run rather than being silently treated as code tasks. Do not add recursive planning or arbitrary task discovery to the first version. If GitHub sub-issues are unavailable, accept an explicit ordered issue list rather than building a general Markdown task parser immediately.

If unfinished work exists but no ticket is eligible, report blockers or a dependency cycle. Do not spin or open a successful final PR.

### Distinguish branch acceptance from GitHub closure

Keep child issues open until the final PR merges. Record accepted ticket numbers and commit SHAs in one machine-local checkpoint file outside tracked source, along with the run's branch, base, and active phase. Verify recorded commits belong to the current branch before skipping work on restart. A clean restart at an accepted-ticket boundary is sufficient; stop for inspection on an ambiguous or dirty partial attempt.

For scheduling only, a dependency inside this parent is satisfied when its accepted commit is present on the feature branch. Dependencies outside this run must be resolved and their required code available on the branch. This is an explicit departure from the repository's current [wayfinder frontier rule](../agents/issue-tracker.md), which waits for every blocker to be closed. Do not silently change that general rule or prematurely close issues just to unblock the loop.

The final PR can list `Closes #parent` and a separate closing reference for each completed child. GitHub closes linked issues when the PR merges into the default branch; it does not do so merely because a feature-branch commit exists. See [GitHub's closing rules](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

### Gate each ticket on evidence

The implementer receives the parent spec, one ticket, relevant prior decisions, and explicit permission to implement that ticket. The reviewer receives those requirements, the actual patch, relevant files, and check results, without inheriting the implementer's conversation.

The runner should produce the patch, including newly created files, so a reviewer with `--tools read,grep,find,ls` does not need bash. Request a small exact JSON verdict in the final response and validate its schema and enum values. Pi print output does not itself guarantee JSON conformance. Malformed output, a missing verdict, or a process error is not a pass. Do not grep the whole transcript for a stray `PASS` string.

Run fixed check commands under controller ownership. Do not accept the implementer's claim that tests passed. Review changes to tests and check configuration as part of the patch. Re-run checks after every fix. Final review compares the cumulative change against the parent spec, not merely the last ticket.

### Bound the run and preserve failure evidence

Use an initial implementation attempt plus at most two repair attempts per ticket, configurable wall-clock limits, and one runner lock per branch. Bound final-integration repairs too. On failure, preserve the patch and logs; do not automatically reset or discard work. Persist Pi sessions and name them with ticket, role, and attempt.

The runner owns commits, pushes, and final PR creation. Before creating the PR, look for an existing PR for the same head/base so a restarted run does not create duplicates. Do not implement automatic rebasing, merging, or multiple concurrent feature writers initially.

These are proposed defaults, not measured optimal limits. A branch and worktree isolate Git changes, not host access or credentials. A bash-capable implementation agent still requires trust; policy or sandboxing is a separate decision.

## Local Pi and workspace gotchas

1. **Print mode versus JSON mode.** In installed Pi 0.86.1, `dist/modes/print-mode.js` assigns exit code 1 for a final assistant error/abort in text mode. That particular check is absent from JSON mode. A zero JSON-process exit is therefore insufficient; parse authoritative final message events if using it. Even a successful text-mode exit means the agent finished, not that the ticket passed. See [JSON mode docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md).
2. **Project trust.** Non-interactive Pi does not ask to trust the worktree. Without a saved trust decision, project-local resources can be ignored. Explicitly trust the intended worktree or use per-invocation `--approve` only after reviewing its resources. This flag concerns project trust, not blanket command permission.
3. **Existing command policy.** Actual [bash policy configuration](../../packages/bash-permission/bash-permission.json) makes `git commit *` require approval and denies `git push *`. The [extension](../../packages/bash-permission/index.ts) denies approval-required commands headlessly. Tell workers not to commit or push. The trusted controller's commit/push steps require deliberate user authorization when implementing this design; placing them outside Pi changes which policy governs them. Do not solve this by silently disabling the permission extension. The prose policy document differs from current configuration, so configuration/source were used here.
4. **Role names are not a CLI isolation mechanism.** Use explicit role prompts and tool configuration. A session `--name` is a display label, not automatic activation of the workspace's agent definition or permission identity.
5. **Herdr state is not ticket acceptance.** The local [Herdr skill](../../.agents/skills/herdr/SKILL.md) says `done` and `idle` describe lifecycle state, and prompt waits are not correlated to an individual turn. Neither establishes that tests passed or the spec was met. Running the script in one pane is sufficient for initial visibility. It is not equivalent to having every worker as an interactively take-overable visible subagent; choose the extensible-workflows companion if that becomes essential.
6. **macOS timeouts.** Do not assume GNU `timeout` is installed. Use an available timeout command or a small subprocess timeout implementation. No additional daemon is needed.

## Effort and stopping point

Planning estimates, not measurements:

- Small runner: aim for a same-day first usable version with two role prompts, configured checks, and checkpointing. Allow another day or two of supervised trials before trusting long unattended runs. Much of the variation is repository setup and ticket quality.
- `pi-extensible-workflows`: plausibly a similar day-scale custom workflow plus learning/smoke-testing time. It could win if its starter and recovery model fit immediately; a simple script is not automatically cheaper once recovery requirements grow.
- `pi-workflows`: expect more adaptation for this independent-session shape. Do not spend several days making its conversation model fit just to avoid a small external runner.

Defer dashboards, parallel tickets, per-ticket branches/PRs, a generic workflow DSL, and automatic merge. Test the loop on two small dependent tickets first. The useful first milestone is one complete feature PR, not a reusable orchestration platform.
