---
name: deslop
description: Remove AI-generated code slop and clean up code style. Use as a finishing pass over your ticket diff before declaring done.
---

# Remove AI code slop

Check the diff of your changes and remove AI-generated slop introduced in this
ticket.

## Focus Areas

- Extra comments that are unnecessary or inconsistent with local style
- Defensive checks or try/catch blocks that are abnormal for trusted code paths
- Casts to `any` used only to bypass type issues
- Deeply nested code that should be simplified with early returns
- Other patterns inconsistent with the file and surrounding codebase

## Guardrails

- Keep behavior unchanged unless fixing a clear bug.
- Prefer minimal, focused edits over broad rewrites.
- In your summary, give a one-line justification for each change or removal.
