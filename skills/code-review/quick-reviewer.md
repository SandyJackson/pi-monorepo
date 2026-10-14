# Quick reviewer

Review independently and read-only. Perform every step yourself; quick mode never dispatches subagents.

## 1. Establish the reviewed checkout

Read [review workspace](references/review-workspace.md) and follow Prepare. Finish when its preparation criterion is met.

## 2. Apply the axes

Read [the flag gate and report rules](references/findings-and-report.md) before collecting candidates. Apply every rule in each selected axis to the diff and connected code.

Use [axis selection](references/axis-selection.md), then read and apply each selected method. Follow Checks and experiments in [review workspace](references/review-workspace.md).

Finish when every changed file and its affected callers have been considered under all selected axes, every candidate has a concrete case, and all skipped or incomplete work has a reason.

## 3. Validate every candidate

Re-read the affected code at the pinned head, or the live reviewed contents for the explicit exception. Confirm location, reachable trigger, impact and introduction by the change. Trace callers and existing guards; check whether an existing test or intentional requirement invalidates the candidate. Apply every flag-gate criterion. Use proportionate reproduction when useful, but a complete code trace is sufficient evidence.

Group candidates by root cause. Keep only validated findings; put unresolved concerns in review questions and set-aside behaviour in declined to judge. Empty findings is valid. Finish when every candidate is validated, rejected or recorded as a question, with no speculative concern left in findings.

## 4. Clean up and return the report

Follow Clean up in [review workspace](references/review-workspace.md).

Write the report using [the report rules](references/findings-and-report.md), via bash if write is unavailable. The saved report in the invoking checkout is the sole permitted user-checkout write. Verify that it was saved, then return the same Markdown as your final message. Record cleanup or save failures in coverage and return the report even when saving fails.
