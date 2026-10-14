# Review workspace

Quick reviewers and orchestrators own preparation and cleanup. Axis reviewers use the supplied workspace and leave its lifecycle to the orchestrator.

## Prepare

Decode the router's arguments and verify base and head are full commit IDs present in `checkout`, with each `rev-parse --verify` result equal to the supplied ID. Record the initial user-checkout status. For committed review, allocate a temporary directory, then create a detached worktree at the pinned head:

```sh
review_root=$(mktemp -d)
git -C "$checkout" worktree add --detach "$review_root/head" "$head"
```

Run inspection and checks from that worktree, using `git diff <base> <head> --` as authoritative. Read the final code at head, even when history shows an earlier bug. Keep the temporary directory and worktree paths for cleanup on success or failure.

For `uncommitted=true`, work in `checkout` instead. Confirm its current HEAD still equals the pinned head; stop if it moved before review began. Record `git diff HEAD --`, staged and unstaged status, and untracked non-ignored files. Read untracked file contents too. Label the target as a live combined delta against the pinned HEAD. Check HEAD and status again at the end; if files changed during review, report the unstable target and incomplete coverage. Status alone cannot prove an unchanged live tree, so state that limit.

Read the root and scoped repository instructions, documented standards, glossary and relevant ADRs at the reviewed revision. Fetch issue specs yourself using the repository's issue-tracker doc, here `docs/agents/issue-tracker.md`. For a spec path under `checkout`, map it to a repository-relative path and read the pinned-head version when tracked, using the detached worktree or `git show <head>:<path>`. For external or untracked scratch specs, use the supplied path and identify that non-pinned source. If a spec cannot be read, record the gap rather than inventing it. With `spec=none`, label intent inferred from commits and code as inferred.

Preparation is complete when the final comparison, applicable standards and requirements sources are available or each access failure is recorded.

## Checks and experiments

Run proportionate repository checks and small experiments in the detached worktree. Preserve tracked source, index, HEAD and branch state in every checkout. Put probes in disposable untracked files; mutation probes use disposable copies, not edits to tracked source. In live review, use inspection or checks known not to alter the user's checkout. If a check would write there, decline it and record the limit. Dependency setup or unavailable services can limit verification; report that rather than substituting a clean-check claim.

Parallel reviewers share this worktree. Give each disposable experiment a unique path and keep checks that contend for generated files or shared state out of the parallel phase. Return those checks as recommendations for the orchestrator to run serially.

## Clean up

After all reviewers have finished or their processes have been stopped, remove the detached review worktree with `git worktree remove "$review_root/head"`, then remove the owned temporary directory. Remove only disposable probe/build outputs you created if they prevent normal worktree removal. Never force removal of a user's worktree or run broad cleanup. On failure, record the remaining path and reason. For live review, leave the checkout in its original state; there is no review worktree to remove.

Cleanup is complete when the owned worktree is removed or its remaining path and reason are recorded. Save and return the report through [findings and report](findings-and-report.md), even if cleanup fails.
