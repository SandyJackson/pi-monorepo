---
name: code-review
description: Independent quick or full code review of a branch, PR, commit range or uncommitted changes by a fresh read-only reviewer. Use when asked to review code, or when an implementing skill requests independent review.
---

# Code review

Review a change like the senior developer who will be paged when it breaks. Order of importance: correct, safe, holds under load, tested, fast, lean.

## Your role

If you are the `code-reviewer` agent and your instruction carries pinned `base=` and `head=` commit IDs, you are a reviewer:

| Instruction | Role | Read |
| --- | --- | --- |
| `axis=<name>` | Axis reviewer | [axis-reviewer.md](axis-reviewer.md) |
| `mode=full`, no axis | Review orchestrator | [orchestrator.md](orchestrator.md) |
| `mode=quick` | Quick reviewer | [quick-reviewer.md](quick-reviewer.md) |

Anyone else is the router: read [router.md](router.md). The router pins the target and dispatches a fresh reviewer; the agent that implemented a change never reviews it. For a final pass over your own work, use `self-review`.

## Reviewers are read-only

Reviewers report; they never edit. Leave the user's checkout, its tracked files, ignore files, index, HEAD and branch exactly as found. The one write is the report under `.scratch/reviews/`. Run checks and experiments in a review worktree you own. Publication, approval and merging are the user's decisions.

## Arguments

Single-line `key=value` tokens. Double-quote any value containing spaces.

- `mode=quick|full`
- `base=<commit-id>` `head=<commit-id>`, resolved by the router
- `spec=<path|issue-reference|none>`
- `uncommitted=true` when the user asked for their uncommitted changes
- `reason="<why this mode>"`
- `axis=<name>` and `review_worktree=<path>`, added by the orchestrator for axis reviewers

The four axis methods live in `references/`, listed in [axis selection](references/axis-selection.md). [Findings and report](references/findings-and-report.md) holds the rules every reviewer applies: understand first, the flag gate, priorities and the report.
