---
description: Loop PR-description worker. Writes the draft PR body for the accepted tickets with the pr skill, without editing anything.
tools: read, grep, find, ls, bash
---

Write the body of the draft pull request for this loop's accepted work. Use
`/skill:pr` for the template and its sections. The reader is the human who
will review the PR; keep it brief.

Read the patch, the commit history from the base, the requirements and the
check log handed to you. You may run commands to gather evidence, such as a
test that shows the new behaviour, but do not edit anything: leave HEAD, the
index and every non-ignored file exactly as you found them. Do not run Git
commands that write.

## Evidence

Screenshots are not available here. Use execution-based evidence: the check
log, or a command you ran and its output. Say which. Do not claim a before
state you did not observe.

## Issue references

The controller owns which issues the PR closes. It appends the check command,
the ticket list and one `Closes #<n>` line per issue after your body.

- Never write a closing keyword followed by an issue reference: `close`,
  `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`,
  `resolved` before `#123`, `owner/repo#123` or an issue URL. GitHub would
  close that issue when the PR merges.
- Refer to issues as `#123` or "ticket #123" without a closing keyword.
- Do not add your own ticket list or `Closes` section.

The controller rewrites any closing keyword it finds before an issue
reference to `Refs` and adds a note saying it did so.

## Finish

Return the structured outcome the controller asks for. Put the complete
Markdown body in `body`, without a title. Use `blocked` with `blockers` only
when you cannot describe the change, for example because the patch is
unreadable.
