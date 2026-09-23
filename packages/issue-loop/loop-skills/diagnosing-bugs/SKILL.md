---
name: diagnosing-bugs
description: Diagnosis discipline for repair attempts. Use when the check command or review findings show a failure you do not yet understand: build a tight feedback loop first, hypothesise second, fix last.
---

# Diagnosing Bugs

A discipline for failures you do not yet understand. Skip phases only when
explicitly justified in your summary.

Repairs are budgeted: there are no unlimited attempts. Make each one count,
and report what blocks you rather than burning an attempt on a guess.

Redact secrets in anything you write down: `<REDACTED>` in place of the
value, and quote only the output lines that carry the signal.

## Phase 1: Build a feedback loop

This is the skill. Everything else is mechanical. If you have a **tight**
pass/fail signal for the failure (one that goes **red** on this failure), you
will find the cause. If you do not, no amount of staring at code will save
you.

Your first candidate is the ticket's check command: run it, watch it fail,
confirm it drives the actual failure rather than something nearby. If it is
too slow or too coarse to debug against, tighten it: narrow the test scope,
assert the specific symptom, pin time and seeds until the verdict is
deterministic. Seconds, not minutes; same verdict every run.

Phase 1 is done when you can name one command you have already run at least
once that goes red on this failure and green once fixed. If you catch yourself
building a theory before that command exists, stop: jumping to a hypothesis
is the exact failure this skill prevents.

## Phase 2: Reproduce + minimise

Run the loop. Watch it go red on the reported failure.

Then shrink the repro to the smallest scenario that still goes red. Cut
inputs, callers, config, and steps one at a time, re-running after each cut,
keeping only what is load-bearing. Done when removing any remaining element
turns the loop green. A minimal repro becomes the regression test.

## Phase 3: Hypothesise

Generate 3–5 ranked hypotheses before testing any of them. Each must be
falsifiable: "If X is the cause, then changing Y will make the failure
disappear." If you cannot state the prediction, discard the hypothesis. Rank
them, then proceed with your ranking.

## Phase 4: Instrument

Each probe maps to one prediction from Phase 3. Change one variable at a
time. Prefer debugger or REPL inspection where available; otherwise targeted
logs at the boundaries that distinguish hypotheses, never log-everything.
Tag every debug log with a unique prefix (e.g. `[DEBUG-a4f2]`) so cleanup is
a single grep.

## Phase 5: Fix + regression test

Write the regression test before the fix, at the seam where the test
exercises the real failure pattern as it occurs at the call site. If no such
seam exists, say so in your summary: the architecture is preventing the
failure from being locked down, and that is itself the finding. Otherwise:
watch it fail, apply the fix, watch it pass, re-run the Phase 1 loop against
the original scenario.

## Phase 6: Cleanup

Before declaring done: the original repro no longer reproduces, the
regression test passes (or the missing seam is documented), all tagged debug
logs are removed, and throwaway harnesses are deleted.
