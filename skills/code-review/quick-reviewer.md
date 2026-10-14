# Quick reviewer

Review independently and read-only. Perform every step yourself; quick mode never dispatches subagents.

## 1. Establish the reviewed checkout

Decode the router's arguments and verify base and head are full commit IDs present in `checkout`, with each `rev-parse --verify` result equal to the supplied ID. Record the initial user-checkout status. For committed review, allocate a temporary directory, then create a detached worktree at the pinned head:

```sh
review_root=$(mktemp -d)
git -C "$checkout" worktree add --detach "$review_root/head" "$head"
```

Run inspection and checks from that worktree, using `git diff <base> <head> --` as authoritative. Read the final code at head, even when history shows an earlier bug. Keep the temporary directory and worktree paths for cleanup on success or failure.

For `uncommitted=true`, work in `checkout` instead. Confirm its current HEAD still equals the pinned head; stop if it moved before review began. Record `git diff HEAD --`, staged and unstaged status, and untracked non-ignored files. Read untracked file contents too. Label the target as a live combined delta against the pinned HEAD. Check HEAD and status again at the end; if files changed during review, report the unstable target and incomplete coverage. Status alone cannot prove an unchanged live tree, so state that limit.

Read the root and scoped repository instructions, documented standards, glossary and relevant ADRs at the reviewed revision. Fetch issue specs yourself using the repository's issue-tracker doc, here `docs/agents/issue-tracker.md`. For a spec path under `checkout`, map it to a repository-relative path and read the pinned-head version when tracked, using the detached worktree or `git show <head>:<path>`. For external or untracked scratch specs, use the supplied path and identify that non-pinned source. If a spec cannot be read, record the gap rather than inventing it. With `spec=none`, label intent inferred from commits and code as inferred.

Finish when the final comparison, applicable standards and requirements sources are available or each access failure is recorded.

## 2. Apply the axes

Read [the flag gate and report rules](references/findings-and-report.md) before collecting candidates. Apply every rule in each selected axis to the diff and connected code:

- Always read and apply [correctness and requirements](references/correctness-requirements.md).
- Always read and apply [design and maintainability](references/design-maintainability.md).
- Read and apply [tests and verification](references/tests-verification.md) when behaviour changes. For changes that alter no behaviour, record the skip and reason.
- Read and apply [security and resilience](references/security-resilience.md) when a trust boundary is crossed: external input parsing, filesystem paths, shell or exec, network, authentication, secrets, dependencies, permissions, or concurrency on shared state. Otherwise record the skip and reason.

Run proportionate repository checks and small experiments in the detached worktree. Preserve tracked source, index, HEAD and branch state in every checkout. Put probes in disposable untracked files; mutation probes use disposable copies, not edits to tracked source. In live review, use inspection or checks known not to alter the user's checkout. If a check would write there, decline it and record the limit. Dependency setup or unavailable services can limit verification; report that rather than substituting a clean-check claim.

Finish when every changed file and its affected callers have been considered under all selected axes, every candidate has a concrete case, and all skipped or incomplete work has a reason.

## 3. Validate every candidate

Re-read the affected code at the pinned head, or the live reviewed contents for the explicit exception. Confirm location, reachable trigger, impact and introduction by the change. Trace callers and existing guards; check whether an existing test or intentional requirement invalidates the candidate. Apply every flag-gate criterion. Use proportionate reproduction when useful, but a complete code trace is sufficient evidence.

Group candidates by root cause. Keep only validated findings; put unresolved concerns in review questions and set-aside behaviour in declined to judge. Empty findings is valid. Finish when every candidate is validated, rejected or recorded as a question, with no speculative concern left in findings.

## 4. Clean up and return the report

Remove the detached review worktree with `git worktree remove "$review_root/head"`, then remove the owned temporary directory. Remove only disposable probe/build outputs you created if they prevent normal worktree removal. Never force removal of a user's worktree or run broad cleanup. On failure, record the remaining path and reason. For live review, leave the checkout in its original state; there is no review worktree to remove.

Write the report using [the report rules](references/findings-and-report.md), via bash if write is unavailable. The saved report in the invoking checkout is the sole permitted user-checkout write. Verify that it was saved, then return the same Markdown as your final message. Record cleanup or save failures in coverage and return the report even when saving fails.
