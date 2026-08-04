# Migrate workspace resources

## What to build

Move all current skills, agents, and authored supporting guidance into the Pi workspace while preserving their names, contents, frontmatter, companion files, and current runtime semantics.

## Acceptance criteria

- [ ] All 23 skills are available through the aggregate Pi package with their canonical names and contents preserved.
- [ ] All 5 agents are present in the workspace with descriptions, prompts, tools, models, and extension metadata preserved.
- [ ] Workspace agents have documented manual-copy instructions for Pi's existing global agent discovery.
- [ ] Existing user/project agent discovery and project-trust behavior remain unchanged; package-native agent discovery is not introduced.
- [ ] Bash policy guidance and other stable authored documentation are included without moving generated or project-specific documentation into the workspace.
- [ ] Resource inventory checks detect missing, renamed, malformed, or incomplete skills and agents.
- [ ] The external `pi-web-access` prerequisite remains separate and is not vendored or republished.

## Blocked by

- Establish the pnpm Pi workspace

## Blocking

- Validate installations and perform cutover
