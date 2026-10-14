---
name: self-review
description: Self-review your own changes before reporting implementation complete, or when asked to clean up code or remove over-engineering.
---

# Self-review

Run this final pass in the implementing agent's existing context, with no subagents. This is self-review, not independent review. Use `code-review` for an independent review by a fresh agent.

## 1. Re-read the change

Identify the task's requirements and the diff containing your work, including committed, uncommitted and new files. Use the task's base when given; otherwise establish the base from the branch history. Keep unrelated user changes outside the edit scope.

Re-read every changed file against the task and surrounding code. Trace changed behaviour through callers and error paths. Account for each requirement as implemented, deliberately deferred or still missing before moving on.

## 2. Simplify and fix

Inspect the whole diff for:

- Slop: unnecessary comments, defensive checks or exception handling abnormal for the code's trust boundary, type-system escapes such as `any` casts, needless nesting, and patterns inconsistent with surrounding code.
- Unrequested complexity: unused options, speculative code, and abstractions without a present need. Prefer deletion, existing code, standard-library or platform features when they preserve the required behaviour with less complexity.
- Correctness: concrete cases where the change fails the task, breaks a caller or mishandles an error path.
- Test sanity: could the tests pass while the implementation is materially wrong? Check that expected values come from the spec or worked examples rather than mirroring the implementation, assertions cover the claimed result, and mocks do not hide the behaviour under test.

Apply focused fixes. Preserve behaviour unless fixing a clear bug; the task and documented repository standards take precedence over generic cleanup preferences. Keep a one-line justification for each change or removal, naming its location and the concrete problem it addresses. Leave uncertain behaviour changes as questions for the user.

Finish this step when every changed file has been checked against these categories and each concrete problem is fixed or recorded as unresolved.

## 3. Verify and report

Run the repository's prescribed checks in its required order. Use focused tests while fixing problems and run the full required checks on the final change. If a check fails, fix problems within scope and rerun the affected checks; report unrelated failures or blockers explicitly.

Re-read the final diff to confirm the fixes still satisfy the task and introduced no unrelated changes. Report:

- Each change or removal with its one-line justification, or that no changes were needed.
- Checks run and their actual results, including anything not run and why.
- Unresolved problems or questions.

Label the result as self-review, not independent approval.
