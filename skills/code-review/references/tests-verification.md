# Tests and verification

Could the tests pass while the implementation is materially wrong? Read the changed tests, the related existing tests and the production code they exercise.

**Assertion completeness.** The most common weakness in generated tests: asserting only the obvious output and missing the full "blast radius" of a state change. When a test triggers an action, ask what *else* changed. Flag when:

- A test asserts a return value but ignores side effects
- A test checks that an operation succeeded but not that it produced the right result
- A test verifies the happy path but skips boundary conditions (empty inputs, nulls, maximum values, off-by-one)
- Error-path tests only check that an error was thrown, not the error message, type, or cleanup behavior

**Smells:**

| Smell | What it looks like | Why it matters |
| --- | --- | --- |
| **Implementation Mirror** | Expected values computed using the same logic as production code | Test and production code will always agree, even when both are wrong. Hardcode expected values from a known-good source. |
| **Rotten Green** | Assertions inside `try`/`catch` or conditional branches | Test always passes because the assertion is never reached |
| **Sleepy Test** | Hard-coded `sleep()`/`setTimeout()` | Flaky in CI, slow everywhere. Use polling or explicit waits. |

**Mocking.** Mock at architectural boundaries, not at every function call. Respect the codebase's existing mocking convention. Flag inconsistency within the project, not deviation from a universal rule. Flag a mock that would hide the very behaviour the change alters.

**Coverage.** Risky new logic (a branch, a parser, money, security, data writes, a bug fix) with no test that fails when it breaks. One good test, not coverage.

**Would the tests catch a regression?** Answer the last question by experiment, not by reading. Invert one condition the change adds (drop a negation, swap `&&` for `||`), run the suite, then restore the file from a copy. A mutation that stays green is a finding: name the test case that is missing. Do this only in a worktree you own (see [review workspace](review-workspace.md)).

**Observable verification.** Prove behaviour where a user meets it: run the CLI and check output and exit status, replay a parser input, read back a stored value. "It compiles" is not evidence. Record exact commands and results.

Each candidate names the wrong implementation that would stay green, or the missing assertion.
