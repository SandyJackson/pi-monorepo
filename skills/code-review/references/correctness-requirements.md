# Correctness and requirements

Trace behaviour, not just changed lines. Apply each check to the reviewed target:

- Map each stated requirement to the code that implements it. Identify missing, partial or unrequested behaviour. With no spec, label the intent inferred and use established contracts as evidence.
- Read callers of every changed function, its callees, types and related tests. Follow input through state changes to observable output, including callers outside the diff.
- Trace empty, zero, boundary, invalid and error cases that reachable callers can supply. Check propagation, cleanup, cancellation and partial failures as well as the successful path.
- Check compatibility of signatures, return values, persisted formats, CLI output and exit status. Name the consumer a change breaks.
- For retries and repeated execution, trace what happens on a second run and after interruption. For shared state, trace two actors' ordering and ownership against the load evidenced by repository docs or deployment config. State the assumed load.
- Distinguish the root cause from a guard, retry or cast masking its symptom. Propose a fix at the contract that actually fails.
- Treat spec silence as a reason to inspect existing usage and contracts, not as permission for broken behaviour. Questions based only on guessed expectations remain questions.

Finish with a reachable execution path for each candidate, including the specific input or state, affected caller and wrong result. Validate it against the final head through the shared flag gate before reporting.
