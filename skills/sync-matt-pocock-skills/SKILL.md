---
name: sync-matt-pocock-skills
description: Review and adopt updates from mattpocock/skills into skills/matt-pocock — fetch, diff each skill, summarize changes with pros/cons and a recommendation, then adopt only what the user approves.
disable-model-invocation: true
---

# Sync Matt Pocock Skills

Check `skills/matt-pocock/` against its upstream (`mattpocock/skills`), report what changed, adopt what the user approves. The script does the mechanical work; the review and every adoption decision are yours and the user's.

The directory is a **mirror**: its content should match upstream exactly, so the next review diffs clean. Skills you write yourself live at `skills/<name>`, never inside the mirror.

## The script

`scripts/sync-upstream-skills.sh` (run from the repo root; it maps upstream `skills/engineering|productivity/<skill>` to local `skills/matt-pocock/<skill>`):

- **Review mode** (no args): fetches the upstream remote and writes `.scratch/skills-sync/` — `SUMMARY.md` (per-skill: changed with +added/−removed counts, new upstream, local-only, up to date) plus one diff file per changed skill. New upstream skills get their `SKILL.md` as `<skill>.new.md`. Touches nothing else.
- **`--apply [skill ...]`**: mirrors the named skills from upstream. With no names, mirrors everything and deletes local skills upstream dropped. Stages nothing; you commit.

Both modes refuse to run with uncommitted changes under `skills/matt-pocock/`. Commit or stash first.

## Process

### 1. Run the review

Run the script in review mode.

Done when: `SUMMARY.md` exists and accounts for every upstream skill as changed, new, local-only, or up to date.

### 2. Read and classify

Read every diff in `diffs/`, and every `.new.md` for new skills.

Classify each change as **editorial** (punctuation, phrasing — no behavioral difference) or **behavioral** (new or altered process, rules, artifacts, or outputs). A skill whose whole diff is editorial needs a one-line note, not a pros/cons write-up.

For each changed skill, look for two signals beyond upstream's intent:

- **Local customizations**: hunks that exist only in your copy (the diff shows them as deletions of lines upstream never had). Name them — the user decides whether dropping them is the point or a loss.
- **Coupling**: the change assumes another upstream change (a redesigned skill referenced by its consumers). Flag bundles that only make sense adopted together.

Done when: every changed and new skill has a one-line summary, and every behavioral change has pros, cons, and an adopt/skip recommendation.

### 3. Present and wait

Present a table: skill, summary, classification, recommendation — then the prose for anything behavioral. State the recommended bundle (skills that must move together).

Stop here. Adopt nothing until the user picks.

### 4. Adopt

Run the script with `--apply` and the approved skill names. New upstream skills are adopted by name the same way. Then:

- Stage and commit, per approved skill or one grouped commit when they were coupled. Message: `sync(skills): <what and why> ← mattpocock/skills@<rev>`.
- Flag anything the user should know post-adoption (e.g. a skill's invocation behavior changed, a reference doc was added).

Done when: `git status` is clean under `skills/matt-pocock/`, the commit message names the upstream revision, and the review scratch directory is deleted.
