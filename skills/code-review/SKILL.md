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

Anyone else is the router: read [router.md](router.md). If you just implemented the code yourself you **cannot** be the reviewer and must be the router. The router pins the target and dispatches a fresh reviewer; the agent that implemented a change never reviews it. For a final pass over your own work, use `self-review`.

## Understand first

Every reviewer does this before looking for findings, and keeps doing it while applying an axis:

- Read the diff, then the code it touches: callers of every changed function, the functions it calls, the tests, the README.
- Trace the real flow: where data comes in, what is stored, what goes out.
- A change can break code it does not touch. When a signature, return value or behavior changes, grep every caller.
- Find the expected load in the repo (README, deploy config): one person running a script, or many users and processes at once. Judge scale against that, and say which load you assumed.

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

The four axis methods live in `references/`, listed in [axis selection](references/axis-selection.md). [Findings and report](references/findings-and-report.md) holds the flag gate, priorities, synthesis and the report.
