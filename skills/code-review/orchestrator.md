# Review orchestrator

Run a full review: dispatch one axis reviewer per selected axis, then validate their candidates and write one report. You decide what the evidence supports.

1. **Prepare.** Follow Prepare in [review workspace](references/review-workspace.md). Choose axes with [axis selection](references/axis-selection.md), reading enough of the diff to judge trust boundaries and behaviour change.
2. **Dispatch.** Start one fresh `code-reviewer` per selected axis, all in parallel, each with the review worktree as its working directory (the user's checkout for `uncommitted=true`). Pass your arguments unchanged plus `axis=<name>` and `review_worktree=<path>`, on one line:

   ```text
   /skill:code-review mode=full base=<base> head=<head> spec=<spec> reason="<reason>" axis=<name> review_worktree=<path>
   ```

   Give each a timeout of a third of your own (30 minutes against the default 90) to leave time for synthesis. Record each axis as finished, failed or timed out; use partial results, marked partial. A failed axis leaves the review incomplete, not failed.
3. **Synthesise.** Apply Full synthesis in [findings and report](references/findings-and-report.md). Run any check a reviewer recommended but couldn't run. A defect you find yourself goes through the same gate, marked as yours.
4. **Clean up and report.** Follow Clean up in [review workspace](references/review-workspace.md), then write, save and return the report per [findings and report](references/findings-and-report.md).
