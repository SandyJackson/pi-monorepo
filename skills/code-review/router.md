# Router

Pin the target, resolve the spec, pick the mode, then dispatch one fresh `code-reviewer`. Read only what routing needs; the reviewer reads the code.

## 1. Pin the target

Resolve refs to commit IDs with `git rev-parse --verify '<ref>^{commit}'`.

- **head**: the user's `head=`, default `HEAD`.
- **base**: the user's `base=`, used as given. Otherwise the merge-base of head and the default branch, found with `git symbolic-ref --short refs/remotes/origin/HEAD`. If that fails, ask the user which branch to compare against.

Stop on a ref that doesn't resolve, or when `git diff --quiet <base> <head>` reports no difference.

**Uncommitted changes**, only when the user asks for them: set base and head to the current `HEAD` and add `uncommitted=true`. The target is `git diff HEAD` plus untracked files from `git status --porcelain`. Stop if both are empty. Ask the user not to edit files until the review returns.

Done when base and head are commit IDs and the target is non-empty.

## 2. Resolve the spec

Take the first that applies:

1. The user's `spec=`, including `spec=none`.
2. Issue references (`#123`, `Closes #45`) in `git log <base>..<head> --format=%B`.
3. A spec file under `docs/`, `specs/` or `.scratch/` matching the branch or feature.
4. Ask the user for a path, an issue reference or `none`.

Ask when more than one candidate fits equally. Pass the reference, made absolute if it is a path; the reviewer reads it.

## 3. Pick the mode

Use the user's `quick` or `full`. Otherwise choose:

- **quick** for documentation, configuration or a contained change in one area.
- **full** for behaviour spanning modules, trust boundaries, persistence or concurrency.

Risk outranks size. When unsure, choose full. Tell the user the mode and why, and pass it as `reason=`.

## 4. Dispatch

Start one fresh `code-reviewer` with this checkout as its working directory and nothing from your conversation. The instruction is one line, starting:

```text
/skill:code-review mode=<mode> base=<base> head=<head> spec="<spec>" reason="<reason>"
```

Add `uncommitted=true` when it applies. Wait for the report and return it with its saved path. If the reviewer fails or times out, say the independent review did not complete.

Where nested subagents are unavailable, a full review runs its orchestrator here: read [orchestrator.md](orchestrator.md) with these arguments and dispatch the axis reviewers from this session. Say so in the coverage note. Where no subagents are available, give the user the instruction to run in a fresh `code-reviewer` session.
