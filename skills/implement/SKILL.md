---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use `/code-review` to review the work
Discuss the review feedback with the user, ask for guidance on how to address the reviewers comments.

Implement the fixes as instructed then add a fixup commit and `/code-review` again

This cycle continues until the user tells says you are done, then ensure your commit message is appropriate.
If you are working with an issue then close the issue. If that issue is blocking any other issue then check if you can remove the `blocked` tag from that issue.
