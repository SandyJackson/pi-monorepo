---
name: self-review
description: Self-review and deslop your own change before reporting it done. Use when finishing an implementation, or when asked to remove slop or over-engineering from your work.
---

# Self-review

A final pass over your own change, in your own context. You may fix what you find. This is not independent review: for that, use `code-review`.

## 1. Re-read the change

Diff your work against the task's base, including uncommitted and new files; leave unrelated changes alone. Re-read every changed file against the task and the code around it, and trace changed behaviour through its callers and error paths. Done when each requirement is implemented, deliberately deferred or listed as missing.

## 2. Remove slop

- Extra comments that are unnecessary or inconsistent with local style
- Defensive checks or try/catch blocks that are abnormal for trusted code paths
- Casts to `any` used only to bypass type issues
- Deeply nested code that should be simplified with early returns
- Other patterns inconsistent with the file and surrounding codebase

## 3. Cut what isn't needed

Tag each cut:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

Lazy, not negligent: trust-boundary validation, data-loss handling, security, and accessibility are never on the chopping block. A single smoke test or `assert`-based self-check is the minimum, not bloat; never flag it for deletion.

## 4. Check the tests

Could the tests pass while the implementation is materially wrong? Expected values come from the spec or worked examples, not from re-running the implementation's logic. Assertions cover the claimed result and its side effects. Mocks sit at architectural boundaries and leave the changed behaviour real.

## 5. Fix, verify and report

- Keep behavior unchanged unless fixing a clear bug.
- Prefer minimal, focused edits over broad rewrites.
- The task and documented repository standards outrank these generic rules.

Run the repository's checks in its documented order, then re-read the final diff. Report:

- Each change or removal with a one-line justification (its tag and location).
- Checks run and their results, and anything not run.
- Open problems and questions.

Say the result is a self-review, not an independent approval.
