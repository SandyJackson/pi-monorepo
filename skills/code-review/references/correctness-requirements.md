# Correctness and requirements

**Requirements.** Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. A vague spec ("build me X") gets the smallest version that does the core job. Treat spec silence as a reason to inspect existing usage and contracts, not as permission for broken behaviour. Questions based only on guessed expectations remain questions.

**Bug:** wrong result, crash, missed edge case (empty, zero, last item, rounding, time zones), a caller broken by the change, a fix applied in one caller while the shared function stays broken.

**Scale:** fine for one user, wrong for many: check-then-write races, the same work done by every process, memory or lists that only grow, a query per item, O(n^2) on big input, per-process state that must be shared.

**Contracts:** signatures, return values, persisted formats, CLI output and exit status. Name the consumer a change breaks.

**Re-runs:** what happens if this runs twice, or after a run crashed halfway?

**Root cause:** a guard, retry or cast that hides a symptom while the broken contract stays broken. Point the fix at the contract.

Each candidate names the input or state, the path it takes and the wrong result.
