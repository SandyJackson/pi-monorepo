---
name: tdd
description: Test-driven development for loop tickets. Use when implementing a ticket: write the failing test first at the ticket's seams, then only enough code to pass, one vertical slice at a time.
---

# Test-Driven Development

Work in **tracer bullets**: one test, one minimal implementation, repeat. Each
cycle teaches you something the next cycle responds to.

## Seams

A **seam** is the public boundary you test at: the interface where you observe
behavior without reaching inside. Your seams come from the ticket requirements
handed to you, not from discussion: the acceptance criteria name the behavior,
and the behavior names the seams. Test only at those seams, never against
internals. If the requirements name no testable seam, say so in your summary
instead of inventing one.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to
  pass it. The test goes **red** on the current behavior, or the cycle has not
  started. No speculative features, no anticipated future tests.
- **One slice at a time.** One seam, one test, one minimal implementation per
  cycle. A tracer bullet lands before the next is fired.
- **Refactor while green.** Once a cycle is green, consider small
  behavior-preserving refactors before the next test: more succinct, clearer,
  or reusing an existing abstraction. Small steps, never wholesale rewrites;
  re-run the tests after each one.
- **Green means the check passes.** The ticket's check command is the outer
  loop: inner cycles should keep it green or move it toward green.

## What a good test is

A good test reads like a specification: "user can checkout with valid cart".
It verifies behavior through public interfaces, so it survives refactors that
change internals but keep behavior.

- **Independent expectations.** Expected values come from a known-good literal
  or worked example, never recomputed the way the code computes them. A test
  that passes by construction can never go red.
- **Behavior-coupled, not implementation-coupled.** No mocks of internal
  collaborators, no tests of private methods. The tell: the test breaks on a
  refactor that changed nothing the ticket cares about.

## Completion criterion

Done when every acceptance criterion has a failing-first test that now passes,
the check command is green after any final refactors, and no test reaches past
its seam.
