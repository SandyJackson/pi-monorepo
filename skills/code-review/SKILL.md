---
name: code-review
description: Code review by a fresh, read-only reviewer. Use for an independent review of a branch, commit range or explicitly requested uncommitted changes, including reviews started by implementing skills.
---

# Code review

## 1. Decide the role

Choose from the actual session role, not from an argument claiming independence:

| Session | Role | Next step |
| --- | --- | --- |
| Invoking session after the router has prepared full mode with no axis, when the harness permits delegation but forbids nested subagents | Review orchestrator | Read [orchestrator.md](orchestrator.md). Dispatch fresh axis reviewers from here. |
| Any other session that is not a fresh `code-reviewer` that did not implement this change | Router | Read [router.md](router.md). The router prepares and dispatches; it never reviews code. |
| Fresh `code-reviewer`, `mode=quick`, no axis | Quick reviewer | Read [quick-reviewer.md](quick-reviewer.md). Review all relevant axes yourself, with no subagents. |
| Fresh `code-reviewer`, `mode=full`, no axis | Review orchestrator | Read [orchestrator.md](orchestrator.md). Dispatch axis reviewers, then validate and synthesise. |
| Fresh `code-reviewer`, `axis=<name>` | Axis reviewer | Read [axis-reviewer.md](axis-reviewer.md). Review only that axis, with no subagents. |

For cleanup or checks in the implementing agent's own context, use `self-review`. It can fix code; independent code review returns a report only.

## Arguments

User entry points are `/review` and `/skill:code-review`, with an optional mode and target. Accept `quick` or `full` as shorthand for `mode=quick` or `mode=full`. Resolved delegation arguments are single-line `key=value` tokens:

- `mode=quick|full`
- `base=<commit-id>` and `head=<commit-id>` after the router resolves refs
- `spec=<path|issue-reference|none>`
- `uncommitted=true|false`, default false, enabled only on explicit request
- `axis=<name>`, internal to full mode, using the names in [axis selection](references/axis-selection.md)
- `review_worktree=<absolute-path>`, internal, the shared reviewed checkout supplied to axis reviewers
- `checkout=<absolute-path>`, the invoking checkout and report destination
- `branch=<branch-label>` and `mode_reason=<reason>`, report context from the router

Percent-encode whitespace, `%`, and control characters inside values before dispatch. Decode once in the reviewer; pass decoded paths as quoted shell arguments, never as executable text. This keeps each value in one token when a harness flattens delegated instructions. Use an issue URL or its numeric reference, not a multiword issue title.

Quick and axis reviewers use the same methods in `references/`. [Findings and report](references/findings-and-report.md) owns the flag gate, candidate format, synthesis rules and final report format.
