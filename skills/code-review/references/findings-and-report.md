# Findings and report

## Flag gate

Flag an issue only when all of these hold.

- It affects correctness, security, performance, or maintainability in a meaningful way.
- It is discrete and actionable.
- Fixing the bug does not demand rigor not present in the rest of the codebase (e.g. one doesn't need very detailed comments and input validation in a repository of one-off scripts in personal projects).
- It was introduced by the reviewed change.
- The affected scenario or call path can be demonstrated from the code.
- The author would probably fix it if they knew about it.

Ignore trivial style unless it obscures meaning or violates documented standards. A documented repository standard overrides the generic heuristics in these references; cite it for any finding it supports.

## Check before you report

- Every finding needs a concrete case: "this input or situation leads to this wrong result". No case, no finding.
- Re-read the lines and confirm: the caller exists, the value can really be empty, the code really is unused.
- Propose the smallest fix that works. Prefer fixes that delete code. Never add layers, frameworks or config the problem does not need.
- No style taste, no "consider", no vague worries.

A concern you cannot confirm is a **review question**: say what evidence would settle it.

## Writing a finding

- The comment should be clear about why the issue is a bug.
- The comment should be brief. The body should be at most 1 paragraph.
- The comment should clearly and explicitly communicate the scenarios, environments, or inputs that are necessary for the bug to arise.
- Keep the line range as short as possible for interpreting the issue.

Each finding has a priority, a `file:line` location, the trigger, the impact, the fix and its evidence. When it rests on an assumption, such as what a reasonable person would expect where the spec is silent, it names the assumption.

| Priority | Meaning |
| --- | --- |
| P0 | universal release blocker or critical failure. |
| P1 | urgent defect that should be fixed next.|
| P2 | ordinary defect that should be fixed.|
| P3 | low-impact issue that is still worth fixing.|

Evidence is **reproduced** (a command or experiment showed it) or **traced in code** (the execution path proves it). Keep checks you ran separate from checks you recommend.

## Axis candidate return

Axis reviewers return candidates, not a report. Give each an ID (`tests-1`) plus the finding fields above. Then list: files and callers examined, the spec or inferred intent used, checks run with results, review questions, declined-to-judge items and coverage limits. An empty candidate list is a valid result; say whether the axis finished.

## Full synthesis

Validate every candidate yourself against the code at head, using the flag gate and check-before-you-report. Merge duplicates by root cause, keeping every contributing ID. Filter with these:

- **Nitpick gravity.** Reviewers tend to fill their review. If they don't find critical issues, they'll inflate nits to fill the space. If a reviewer's findings are all nits and style preferences, the code is probably fine.
- **Hypothetical vs. actual.** "What if someone passes null here?" is only a finding if the caller can actually pass null. Trace the call site. If the input is validated upstream or the type system prevents it, dismiss the finding.
- **"I would have done it differently."** This is a common false positive. A finding that amounts to "I prefer a different approach" is not a bug, not a design flaw, and not actionable unless the reviewer shows a concrete problem with the current approach. Dismiss these.
- **Missing context.** Watch for findings on code the author didn't write or modify, and for patterns flagged that are consistent with the rest of the codebase.
- **When reviewers are right.** Be especially careful about dismissing security findings and correctness bugs. These deserve more scrutiny even when they come from a single reviewer.

Group the results: **act on** (P0, P1), **consider** (P2), **noted** (P3), **dismissed** (rejected or merged, with the reason or the finding it merged into). If your act-on list has more than 5 items, you're probably not filtering hard enough. The dismissed list is a trust mechanism: it lets the user overrule your filtering.

Done when every candidate is a finding, a review question or a dismissal, and every selected axis is recorded as finished, failed or timed out.

## Report

1. Start with `What this change does:` in two or three sentences. Mark the intent inferred when there is no spec.
2. **Findings**, grouped by priority (in full mode by act on, consider, noted). Number findings across all groups, so the user can say "fix 2 and 5". Full mode follows them with the dismissed list.
3. **Review questions**: unconfirmed concerns and the evidence that would settle them.
4. **Declined to judge**: every behaviour you considered and set aside as outside the plan or spec, one line each, with the reason. The user rules on each line; nothing you set aside is dropped silently. An empty list means you set nothing aside.
5. **Coverage note**: base and head IDs, committed or uncommitted target, mode and reason, spec used, axes run, skipped or incomplete, checks run with results, assumed load, what you could not check.
6. End with `Verdict: Ship.` or `Verdict: fix 1 and 3 first.`, and `Lean: -<N> lines possible.` when lean findings exist.

Nothing found: `What this change does:`, then `Looks good. Ship.` and the coverage note. Missing coverage is never a clean review.

Save the report to `.scratch/reviews/<branch>-<head7>-<mode>-<YYYY-MM-DD>.md` in the checkout the review was started from, creating the directory if needed. Take the branch from `git branch --show-current` (`detached` if empty), with `/` and other non-filename characters replaced by `-`. If the file exists, add the time before `.md`. Write it with bash, then return the same Markdown as your final message. If saving fails, say so and still return the report.
