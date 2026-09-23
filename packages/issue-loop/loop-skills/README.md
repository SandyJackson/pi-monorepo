# Curated loop skills

Closed set of skills available to issue-loop workers. Workers start with
`--no-skills`; the settings file may opt in by short name only:

```json
{
  "implementAgent": "./agents/loop-implement.md",
  "implementSkills": ["tdd"]
}
```

Each skill is a directory here named `<skill-name>/` containing a `SKILL.md`.
Names must match `^[a-z0-9-]+$` (max 64 chars, matching Pi's skill name
constraints). At `start`, the controller copies the selected skills into the
run directory (`<run>/skills/<name>/`); workers load them via repeated
`--skill` flags and `resume` reuses the copy, so a run is byte-identical even
if this directory moves on.

To add a skill: vet its `SKILL.md` for outbound references before vendoring.
A skill that names other skills (e.g. "see the `code-review` skill", "call the
Skill tool with X") re-opens the fan-out this closed set exists to prevent —
either remove the cross-references or vendor the referenced skill too and
record why. `reviewSkills` defaults to empty and should stay that way unless a
read-only reviewer aid has earned it.

## Vendored skills

- `tdd/` — loop-specific red-green discipline. Seams come from the ticket
  requirements; no user confirmation, no cross-references.
- `deslop/` — finishing pass over the ticket diff. Behavior-preserving.
- `diagnosing-bugs/` — repair-attempt discipline: tight loop first, theory
  second. User checkpoints and commit-message duties removed; repairs are
  budgeted, blockers go in the summary.
