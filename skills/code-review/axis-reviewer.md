# Axis reviewer

Review only the assigned axis. Perform the work yourself, with no subagent dispatch. Return candidate findings to the orchestrator; it owns synthesis, report saving and workspace cleanup.

## 1. Verify the assignment and workspace

Decode the arguments once. Require `mode=full`, a recognized `axis=` from [axis selection](references/axis-selection.md), and `review_worktree=`. If any is missing or invalid, return the assignment error to the orchestrator rather than broadening the review.

Use the supplied shared workspace as your working directory. Verify that base and head resolve to exactly the supplied full commit IDs and that the workspace's HEAD equals head. For committed review, require a detached HEAD and inspect `git diff <base> <head> --`. For `uncommitted=true`, require the workspace to be `checkout` and inspect the live combined delta against pinned HEAD, including untracked non-ignored files. Record initial HEAD and status, check them again before returning, and report instability and the limits of status-only comparison.

Read [review workspace](references/review-workspace.md) for the standards and spec-source rules in Prepare and the read-only rules in Checks and experiments. Apply those rules in this existing workspace; creation and cleanup belong to the orchestrator. Read the applicable instructions, standards and requirements sources yourself. Preserve the shared workspace and user checkout, including ignore files, index, HEAD and branch state.

Finish when the assigned axis and target are verified and applicable sources are available or their access failures recorded. A target mismatch stops inspection and returns incomplete coverage.

## 2. Apply the assigned method

Read [findings and report](references/findings-and-report.md) and the method linked for your assigned axis in [axis selection](references/axis-selection.md). Apply every rule in that method to every changed file relevant to the axis and its connected callers and contracts. Stay within the assigned axis; include a cross-axis observation as a question for the orchestrator, not as an excuse to expand or delegate.

Use proportionate checks and disposable experiments under the shared workspace rules. Keep experiment paths unique to this reviewer. Recommend checks that contend for shared outputs for the orchestrator to run serially. In live review, inspection and non-writing checks are the limit.

Finish when all relevant changed files and connected paths have been considered, every candidate has a concrete case that passes the flag gate, and unfinished work has an explicit coverage limit.

## 3. Return candidates

Re-read candidate locations in the reviewed contents and check reachable triggers, guards, existing tests and intentional requirements. Use Axis candidate return in [findings and report](references/findings-and-report.md). Include no speculative findings; unresolved evidence becomes a question. Return an empty list when no candidate survives.

Finish when each candidate has the shared candidate fields and the return includes checks, scope decisions and coverage limits. Return directly to the orchestrator without writing a report or removing the workspace.
