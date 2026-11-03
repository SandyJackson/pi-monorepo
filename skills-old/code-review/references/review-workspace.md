# Review workspace

Quick reviewers and orchestrators own the review worktree. Axis reviewers use the one they are given.

## Prepare

Check that `base` and `head` resolve to the IDs you were given. Create a detached worktree at head and review there:

```sh
review_root=$(mktemp -d)
git worktree add --detach "$review_root/head" "$head"
```

The target is `git diff <base> <head>`. Commit history helps you understand the change; judge the code as it stands at head.

For `uncommitted=true`, review in the user's checkout instead: the target is `git diff HEAD` plus the untracked files. Read and run checks there, but make no edits, so skip mutation probes.

Read the instructions and standards that apply to the changed files (`AGENTS.md`, `CONTRIBUTING.md`, documented coding standards), plus the glossary and ADRs touching the area. Read the spec: a path directly, or an issue through the repository's issue-tracker doc if it has one, otherwise `gh issue view <n> --comments`. With `spec=none`, infer the intent from commits and code and label it inferred.

Done when the diff, the standards and the spec are read, or each one you couldn't read is recorded.

## Checks and experiments

Run tests, commands and small experiments in the review worktree to back findings with evidence. Install dependencies there only when you are going to run something. A check you couldn't run is a coverage limit, not a pass.

Axis reviewers share one worktree, so they only read it. An axis reviewer that wants to edit or run something adds its own worktree at head the same way, and removes it afterwards.

## Clean up

Remove every worktree you created with `git worktree remove "<path>"`, then its temporary directory. If removal fails, record the path in the coverage note. Clean up even when the review fails.
