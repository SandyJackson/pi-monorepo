---
name: code-review
description: Code review by a fresh, read-only reviewer. Use for an independent review of a branch, commit range or explicitly requested uncommitted changes, including reviews started by implementing skills.
---

# Code review

## 1. Decide the role

Choose from the actual session role, not from an argument claiming independence:

| Session | Role | Next step |
| --- | --- | --- |
| Any session other than a fresh `code-reviewer` that did not implement this change | Router | Read [router.md](router.md). The router prepares and dispatches; it never reviews code. |
| Fresh `code-reviewer`, `mode=quick`, no axis | Quick reviewer | Read [quick-reviewer.md](quick-reviewer.md). Review all relevant axes yourself, with no subagents. |
| Fresh `code-reviewer`, `mode=full`, no axis | Review orchestrator | Reserved for #47. Stop and explain that full mode is not available yet. |
| Fresh `code-reviewer`, `axis=<name>` | Axis reviewer | Reserved for #47. Stop and explain that axis delegation is not available yet. |

For cleanup or checks in the implementing agent's own context, use `self-review`. It can fix code; independent code review returns a report only.

## Arguments

User entry points are `/review quick` and `/skill:code-review quick`. Accept `quick` or `full` as shorthand for `mode=quick` or `mode=full`. Resolved delegation arguments are single-line `key=value` tokens:

- `mode=quick|full`
- `base=<commit-id>` and `head=<commit-id>` after the router resolves refs
- `spec=<path|issue-reference|none>`
- `uncommitted=true|false`, default false, enabled only on explicit request
- `axis=<name>`, internal and reserved for full mode
- `checkout=<absolute-path>`, the invoking checkout and report destination
- `branch=<branch-label>` and `mode_reason=<reason>`, report context from the router

Percent-encode whitespace, `%`, and control characters inside values before dispatch. Decode once in the reviewer; pass decoded paths as quoted shell arguments, never as executable text. This keeps each value in one token when a harness flattens delegated instructions. Use a URL or `#46` for an issue reference, not a multiword issue title.

The four shared axis methods live in `references/`. Quick review reads the relevant files as directed by [quick-reviewer.md](quick-reviewer.md); #47's axis reviewers will use the same files.
