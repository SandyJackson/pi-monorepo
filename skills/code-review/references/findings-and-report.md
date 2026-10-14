# Findings and report

## Flag gate

No concrete case, no finding. Apply every criterion to every candidate:

- The change introduces the defect; a pre-existing defect is outside findings.
- It has a material correctness, security, performance or maintainability consequence.
- It is discrete and actionable, with affected code identified.
- The author would plausibly fix it on seeing the evidence.
- Its trigger and consequence follow from code or stated requirements, not unstated assumptions.
- Affected callers or consumers are identifiable and provably reached, not merely imagined.
- It is not the intended behaviour change. An intentional change can still break a separate established contract; name that contract.
- The proposed fix demands no more rigour than the repository applies to comparable code.

Documented repository standards override generic heuristics. Cite the applicable rule for standard-based findings. Unsupported style preferences stay out. Keep one brief finding per root cause, with a narrow file:line range, trigger, impact, evidence and smallest useful fix direction.

## Priority and evidence

Assign priority by consequence:

| Priority | Meaning |
| --- | --- |
| P0 | Blocks merge regardless of inputs. An unconditional failure of release, operations or core usage. |
| P1 | Must fix before merge. A reachable case causes serious incorrect behaviour, exposure, data loss or a broken required contract. |
| P2 | Worth fixing, not merge-blocking. A concrete lesser defect or maintenance/test gap. |
| P3 | Optional. Keep brief or omit. |

Evidence is `reproduced` when a command or experiment demonstrated the trigger and impact, or `traced in code` when an explicit execution path proves them. `unverified` belongs only in review questions, never in findings. Distinguish checks actually run from checks recommended to the author.

## Axis candidate return

Axis reviewers return candidates to the orchestrator, not a saved final report. Give each candidate an axis-local ID. Include proposed priority, narrow location, reachable trigger and affected caller, impact, evidence status, introduction by this change, and smallest useful fix direction. Cite commands and results for reproduced evidence or the execution path for code traces. Label unresolved concerns as questions.

Also return the assigned axis, files and connected paths examined, requirements sources or inferred intent, checks actually run with results, recommended checks, declined-to-judge decisions and coverage limits. An empty candidate list is valid; distinguish it from unfinished work.

## Full synthesis

Validate every returned candidate against the reviewed contents yourself. Re-read its location, trace the caller and trigger, and check guards, tests, requirements and every flag-gate criterion. Reviewer agreement is a reason to inspect, not proof. Scrutinise a concrete security or correctness case even when only one reviewer found it. Prior conversation, hypothetical callers and preferred alternative designs are not evidence.

Deduplicate by root cause, retaining the strongest evidence and all contributing candidate IDs. One defect reported by several axes gets one finding. Give every candidate an explicit disposition:

| Group | Meaning |
| --- | --- |
| Act on | Validated P0 or P1 findings requiring action before merge |
| Consider | Validated P2 findings worth fixing without blocking merge |
| Noted | Validated P3 findings, kept brief |
| Dismissed with reason | Rejected candidates, with the guard, contract, evidence or failed flag-gate criterion that defeats them |

Unresolved candidates become review questions with `unverified` evidence, not findings or claims of safety. Record their candidate IDs there. Preserve dismissed IDs and a brief reason so the user can challenge the filtering. Merged duplicate IDs link to the retained finding rather than implying the defect was rejected.

Treat more than about five act-on items as a signal to recheck filtering, root causes and priority. This is not a quota: retain every independently supported serious defect. If the returned set contains only nits or unsupported preferences, an empty findings list is the right result; leave taste out rather than promoting it to a defect.

Synthesis is complete when every returned candidate is linked to a validated finding, review question or reasoned dismissal, and every selected axis has a recorded completion, failure or timeout outcome.

## Report

Return these sections even when their lists are empty:

1. **What the change does**. A short factual summary. Mark inferred intent when there is no spec.
2. **Findings by priority**. Number findings across P0 to P3. Each includes location, reachable trigger, impact, evidence status and fix direction. State "No validated findings" when empty; this is not proof of correctness.
3. **Review questions**. Unverified concerns, missing context and the evidence needed to decide them.
4. **Declined to judge**. Each behaviour deliberately set aside and why, or "None". This preserves scope decisions for the user's judgement.
5. **Coverage note**. Include base/head IDs, branch, committed or live target, mode and selection reason, spec reference and any inference, axes run or skipped with reasons, checks and their actual results, assumed load, unavailable checks, limits, cleanup status and saved report path.

Full mode uses these same sections. Within Findings by priority, label P0/P1 as act on, P2 as consider and P3 as noted. Follow them with a dismissed-with-reason list, including duplicate-to-finding links. Keep unresolved candidates in Review questions. In coverage record failed or timed-out axes, partial results used, and the invoking-session fallback when applicable. Missing coverage is not a clean review.

Save under the invoking `checkout`, not the temporary worktree:

```text
.scratch/reviews/<YYYY-MM-DD>-<branch>-<head7>-<mode>.md
```

Use the local date and pinned head's first seven characters. Sanitize the branch label to filename-safe letters, digits, dots, underscores and hyphens, replacing slashes and other characters with hyphens. Keep it a single filename component. For a live review, the head ID identifies the anchor, not the mutable contents; say so in coverage. If the same filename exists, append a time suffix before `.md` to preserve the earlier report.

Create only the report directory and report file in the user's checkout. Preserve ignore files and tracked source. Return the saved Markdown as the final message; publication to GitHub, approval and merge are outside this review.
