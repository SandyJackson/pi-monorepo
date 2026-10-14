# Quick reviewer

Review every relevant axis yourself; quick mode dispatches no subagents.

1. **Prepare.** Follow Prepare in [review workspace](references/review-workspace.md).
2. **Understand first.** Apply Understand first in [findings and report](references/findings-and-report.md).
3. **Apply the axes.** Choose axes with [axis selection](references/axis-selection.md) and apply every check in each selected method to the diff and the code it touches. Run checks and experiments in your worktree. Done when every changed file and its callers have been through each selected axis.
4. **Check before you report.** Put every candidate through the flag gate and Check before you report, re-reading it at head. Merge candidates with one root cause. What fails becomes a review question or is dropped.
5. **Clean up and report.** Follow Clean up in [review workspace](references/review-workspace.md), then write, save and return the report per [findings and report](references/findings-and-report.md).
