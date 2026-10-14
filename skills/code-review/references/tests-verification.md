# Tests and verification

Ask whether the tests could pass while the implementation is materially wrong. Read changed tests, related existing tests and the production code they exercise. Apply each check:

- Assertion completeness: check the claimed result, affected state, side effects, unaffected values and error cleanup. Success alone is weaker than proving the right result.
- Implementation mirror: expected values recomputed by the same algorithm can agree with a bug. Prefer worked examples or requirements independent of the implementation.
- Rotten green: assertions inside optional branches or swallowed exceptions may never execute. Trace whether the assertion is reached and a failure propagates.
- Test boundaries: mocks should isolate external architectural boundaries, not hide the changed contract. Identify the failure a mocked dependency could conceal; respect repository conventions rather than imposing a universal mock count.
- Reliability: inspect timing, random inputs, shared state, cleanup and unavailable services. Use observable completion rather than sleeps where the project supports it.
- Coverage: trace new branches and error paths, integration contracts and the exact regression a bug fix claims to prevent. A concrete wrong implementation that stays green is stronger evidence than a coverage percentage.

When useful and permitted, make a proportionate mutation probe in a disposable copy inside the temporary review area: invert a changed condition or remove a guard, run the relevant test against that copy and discard it. Keep tracked reviewed source untouched. A surviving mutation is a candidate only when it represents materially wrong behaviour and the intended test actually ran against the mutated copy. In live review, decline mutation probes that would alter the user's checkout.

Verify the actual observable contract when possible: run a CLI and inspect output and exit status, replay parser input, or read back stored values. Typechecking alone does not prove these behaviours. Record exact commands and results, including failed or unavailable checks. Keep recommended future checks separate from evidence obtained.

Finish with the wrong implementation or missing observable assertion for each candidate test gap. Apply the shared flag gate and validate at head; test existence, test style or a green suite alone is not a finding or proof of correctness.
