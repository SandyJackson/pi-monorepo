# Security and resilience

**Map the trust boundaries.** Where does untrusted data cross into your system? HTTP requests, form fields, file uploads, webhooks, third-party APIs, message queues, and **LLM output**, plus the local values that look internal because the OS handed them to you: another process's command line or environment, filenames on a shared volume, a path in a job payload. Trust follows who *wrote* a value, not which channel delivered it. Every boundary is attack surface.

**Risk:** security holes (injection, weak randomness, secrets, missing checks on input from users), data loss (errors swallowed, writes in the wrong order, no transaction).

For each boundary the change crosses:

- **Input to sink:** trace it through parsing and validation to shell or exec, queries, rendered output, URLs and filesystem calls. Look for injection and path traversal.
- **Who may act:** authentication, then authorization against the resource's owner, before the protected operation.
- **Disclosure:** secrets and personal data in logs, errors, network requests and model context.
- **Destructive operations:** path resolution, symlinks and check-then-use races before a write or delete.
- **Dependencies:** new packages, lockfile changes, install scripts.
- **Resources:** unbounded input, missing timeouts, retries and cleanup on failure.

Use STRIDE as a quick lens on each boundary: spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege. It raises questions; a finding still needs a path.

Each candidate traces the full path: who supplies the input, which check fails, what it reaches.
