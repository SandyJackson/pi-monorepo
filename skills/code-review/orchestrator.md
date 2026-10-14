# Review orchestrator

Run full mode with no axis assigned. Own the review workspace, dispatch independent axis reviewers, then validate their candidates. Your role is to decide what the evidence supports, not concatenate their reports.

## 1. Prepare and select axes

Read [review workspace](references/review-workspace.md) and follow Prepare. Read [findings and report](references/findings-and-report.md) before dispatch. Inspect the final comparison and connected contracts enough to apply [axis selection](references/axis-selection.md). Record each selected axis and each skip reason.

Finish when preparation and axis selection meet their completion criteria. Keep the same workspace and target for every reviewer.

## 2. Dispatch in parallel

Start one fresh `code-reviewer` per selected axis through the harness's delegation facility. Dispatch all selected axes in parallel, with the shared reviewed checkout as each working directory. Preserve every resolved router argument, including `mode=full`, and add only `axis=<name>` and `review_worktree=<encoded-absolute-path>`. Each instruction begins on one line:

```text
/skill:code-review mode=full base=<base-id> head=<head-id> spec=<encoded-reference> uncommitted=<true-or-false> checkout=<encoded-main-checkout> branch=<encoded-label> mode_reason=<encoded-reason> axis=<name> review_worktree=<encoded-reviewed-checkout>
```

Use the same `code-reviewer` model and thinking level for every axis. Set an explicit timeout shorter than your own effective timeout. With the agent's 90-minute default, allow each axis 30 minutes. If your available budget is smaller, lower the axis timeout to leave time for validation, cleanup and saving. In the invoking-session fallback, use the agent definition's timeout as your orchestration budget. Send scope and requirements references, not implementation conversation or a desired verdict.

Follow the shared workspace's rules for parallel checks. Record each axis's completion, failure or timeout independently. Retain usable partial results as partial, subject to validation; a failed axis does not fail the whole review. If parallel delegation cannot start or the remaining budget prevents it, report the affected axes as incomplete rather than silently switching modes or claiming they ran. Stop any remaining reviewer processes before cleanup.

Finish when every selected reviewer has returned or its failure or timeout is recorded. Keep enough remaining budget to validate the candidates received.

## 3. Validate and synthesise

Apply Full synthesis in [findings and report](references/findings-and-report.md) to every returned candidate, including partial results. Validate against the same pinned head or explicit live contents. Run useful deferred checks serially under Checks and experiments in [review workspace](references/review-workspace.md); distinguish their results from reviewers' claims and future recommendations.

If you notice a new possible defect while validating, treat it as a candidate and apply the same gate and evidence rules. Identify it as orchestrator-originated rather than implying independent corroboration. Record validation you could not finish as a question and coverage limit.

Finish at the shared synthesis completion criterion. Empty findings with incomplete axes must still show the missing coverage.

## 4. Clean up and return

Follow Clean up in [review workspace](references/review-workspace.md), including the final live-target check when applicable. Save the full report under the invoking checkout using [findings and report](references/findings-and-report.md). Verify the saved file and return the same Markdown as your final message. Record cleanup or save failures in coverage and return the report even if saving fails.
