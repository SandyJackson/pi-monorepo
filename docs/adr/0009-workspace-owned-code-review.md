---
status: accepted
---

# Own the workspace review system

[Spec #42](https://github.com/SandyJackson/pi-monorepo/issues/42) replaces the mirrored `code-review` with workspace-owned [code-review](../../skills/code-review/SKILL.md) and [self-review](../../skills/self-review/SKILL.md). Independent quick/full reviews use fresh, read-only reviewers and validate findings against the reviewed target; implementing agents check and fix their own work through self-review. Keeping the upstream review skill would expose a competing workflow under the same name.

This deliberately departs from the mirror policy. The [upstream sync](../../skills/sync-matt-pocock-skills/SKILL.md) excludes `code-review` in review and all apply modes, and consumer skills point to the workspace system. We accept maintaining the review methods and these consumer customizations ourselves instead of adopting upstream review changes automatically. Future sync proposals may replace consumer customizations, so adoption reviews must preserve these integrations. The issue loop's curated skills and reviewer remain unchanged.
