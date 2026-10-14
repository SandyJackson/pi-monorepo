# Security and resilience

Run this axis only when the target crosses a trust boundary. Map who writes each value, what asset or operation it reaches and which actor may control it. A value from the local OS, another process, a shared volume or model output can still be untrusted.

Apply each relevant check to those paths:

- Trace external input through parsing, validation, transformations and the sink. Inspect shell/exec, queries, rendered output, URLs and filesystem operations for injection, traversal or unintended access.
- Check authentication separately from authorization. Trace the actor, resource ownership and permission check before the protected operation.
- Inspect secrets and personal data in storage, logs, errors, network requests and model context. Identify a concrete disclosure path.
- Check path resolution, symlinks, ownership and check/use races before destructive writes or removal. Shape validation alone does not prove permission.
- Inspect dependency and lockfile changes, install scripts and permissions. Advisory reports require reachability analysis; an audit passing does not prove supply-chain safety.
- Trace bounded resource use, timeout, cancellation, retry and failure cleanup. Check concurrency on shared state against actual ownership and expected load.

Use STRIDE as a short lens on each crossed boundary: impersonation, tampering, missing auditability where required, disclosure, denial of service and privilege escalation. It supplies questions, not automatic findings or a universal hardening checklist.

Finish with the full input-to-impact path for every candidate, including who can supply the input and which guard fails. Apply repository standards and the shared flag gate; generic fears about hostile inputs without a reachable path remain questions.
