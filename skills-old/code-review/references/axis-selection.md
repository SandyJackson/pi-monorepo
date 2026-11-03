# Axis selection

Use these exact names in `axis=`:

| Axis | Select | Method |
| --- | --- | --- |
| `correctness-requirements` | Always | [Correctness and requirements](correctness-requirements.md) |
| `design-maintainability` | Always | [Design and maintainability](design-maintainability.md) |
| `tests-verification` | Unless the change alters no behaviour | [Tests and verification](tests-verification.md) |
| `security-resilience` | When the change crosses a trust boundary | [Security and resilience](security-resilience.md) |

Trust boundaries: external input parsing, filesystem paths, shell or exec, network, authentication, secrets, dependencies, permissions, and concurrency on shared state. Judge from what the changed code does, not file types: agent instructions that change permissions cross a boundary.

Record every axis in the coverage note as run, skipped with a reason, or incomplete. A selected axis that failed is incomplete, never clean.
