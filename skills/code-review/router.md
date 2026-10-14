# Router

Prepare the target and dispatch one fresh reviewer. Read only the scope metadata needed for routing, not the code for findings.

## 1. Pin the target

Record the invoking checkout with `git rev-parse --show-toplevel` and its branch with `git branch --show-current`. Use `detached` plus the short head ID as the label when detached. This checkout is the report's main checkout, even when it is itself a worktree.

Resolve the head ref, default `HEAD`, with `git rev-parse --verify --end-of-options '<ref>^{commit}'`. Resolve an explicit `base=` the same way and use that commit directly. With no explicit base, discover the repository's default branch from the remote HEAD symbolic ref or repository metadata. If neither establishes it, ask the user; the current feature branch is not a fallback. Resolve the default branch and compute `git merge-base <default-branch-id> <head-id>` as the base.

Check `git diff --quiet <base-id> <head-id> --`. Exit 0 means empty and stops dispatch; exit 1 means a diff; other failures also stop. Both IDs must resolve before proceeding. Use the final two-commit comparison, not intermediate commit diffs, as the review target.

### Explicit uncommitted review

Normalize an explicit request for staged, unstaged or untracked changes to `uncommitted=true`. Review the combined current checkout delta against `HEAD`, including untracked non-ignored files, in place. Pin base and head to the current `HEAD`; reject conflicting `base=` or `head=` rather than mixing a commit-range review with a live review. Check `git status --porcelain --untracked-files=all` for a non-empty target. Tell the user this is a live review and ask them to pause editing until it finishes.

This branch is deliberately not an immutable snapshot. Dispatch into the invoking checkout and label the exception in the report.

Finish when the comparison is non-empty, both IDs are recorded, and the checkout and branch label are known.

## 2. Resolve the spec reference

Use the first available source:

1. Explicit `spec=`, including `spec=none`.
2. Issue references in `git log <base-id>..<head-id> --format=%B`. For live changes, inspect the current head's commit message. Prefer the originating requirements issue over incidental mentions; ask the user if multiple references leave the choice ambiguous.
3. A spec file under `docs/`, `specs/` or `.scratch/` matching the branch or feature. Ask the user if multiple files match equally.
4. Ask the user for a path, issue reference or `none`.

Pass only the reference. The reviewer reads or fetches its contents. Resolve relative file paths against the invoking checkout to absolute paths before encoding them. Do not invent requirements when the user chooses `none`.

Finish with one reference or `none`; awaiting a user answer is not permission to dispatch with a guessed spec.

## 3. Choose the mode

Accept an explicit mode. Otherwise inspect the change's file list, size and commit descriptions: choose quick for documentation, configuration or a contained low-risk change in one area; choose full for behaviour spanning modules, trust boundaries, persistence or concurrency. Record the reason as `mode_reason=` and announce the choice.

Full mode and `axis=` delegation are reserved for #47. If selected, stop before dispatch and offer an explicit quick review with its coverage limits. Continue only if the user chooses quick; do not silently downgrade.

## 4. Dispatch

Use the harness's delegation facility to start one fresh `code-reviewer`, with the invoking checkout as its working directory and no implementing conversation carried into it. Its instruction must begin with the skill invocation on one line:

```text
/skill:code-review mode=quick base=<base-id> head=<head-id> spec=<encoded-reference> uncommitted=false checkout=<encoded-absolute-path> branch=<encoded-label> mode_reason=<encoded-reason>
```

For live review, change `uncommitted` to true. Use the agent definition's model, thinking level and default timeout. Wait for its report and return it with the saved path. If dispatch fails or times out, report that independent review did not complete, rather than reviewing the code yourself.

Where subagents are unavailable, give the user the resolved instruction and ask them to run it in a fresh reviewer session with the `code-reviewer` definition and this skill loaded. Where only nested subagents are unavailable, this router can still delegate a quick reviewer because quick never dispatches. #47 will let full orchestration run in the invoking session in that environment.

Finish when the reviewer has returned a report or the dispatch failure has been reported. Publication, approval and merging remain the user's decisions.
