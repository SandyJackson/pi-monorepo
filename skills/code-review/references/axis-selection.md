# Axis selection

Quick reviewers apply the selected methods themselves. Full orchestrators dispatch one reviewer per selected axis. Use these exact names in `axis=`:

| Axis | Select when | Method |
| --- | --- | --- |
| `correctness-requirements` | Always | [Correctness and requirements](correctness-requirements.md) |
| `design-maintainability` | Always | [Design and maintainability](design-maintainability.md) |
| `tests-verification` | Behaviour changes; skip only when the change alters no behaviour | [Tests and verification](tests-verification.md) |
| `security-resilience` | A trust boundary is crossed | [Security and resilience](security-resilience.md) |

Trust boundaries include external input parsing, filesystem paths, shell or exec, network, authentication, secrets, dependencies, permissions, and concurrency on shared state. Select from the changed contracts and connected code, not file extensions alone. Agent instructions that change execution or permissions can alter behaviour too.

Selection is complete when each axis is selected or skipped with a target-specific reason. Include every axis and its result or skip reason in coverage; a selected axis that fails is incomplete, not skipped or clean.
