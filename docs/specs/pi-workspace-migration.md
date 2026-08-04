# Pi Workspace Migration Specification

## Problem Statement

As a Pi user, I currently develop custom extensions, skills, and agents inside a dotfiles-managed Pi runtime directory. That directory combines source code with mutable runtime state, installed packages, machine-specific configuration, sessions, logs, and an externally managed Herdr extension. The arrangement makes source changes difficult to type-check, creates dependency paths tied to one directory layout, and requires maintaining a second copied tree under the active Pi configuration directory.

The current custom source also has several independent extension package installations. At least one extension cannot type-check because Pi's runtime-provided packages are available to Pi's loader but not to TypeScript. The bash permission extension has dependencies coupled to the current runtime directory depth. Agents and skills are not represented as a coherent, reproducible source workspace.

The desired result is a GitHub-backed private Pi workspace that can be installed globally on a new machine, updated through Pi's package lifecycle, and used as a fast local development checkout without changing the behavior of the existing extensions, skills, or agents.

## Solution

Create a private pnpm workspace rooted at the personal Pi repository. The repository will contain a root aggregate Pi package, one child extension package per authored extension, all current skills, all current agents, authored supporting documentation, and focused tests.

The aggregate package will expose the authored extensions and skills through Pi's package manifest. Pi will load raw TypeScript directly; the workspace will use a strict root typecheck rather than a build output. Agents will remain source-controlled in the workspace but, during this initial migration, will be manually copied into Pi's existing global agent directory so `herdr-subagent` can retain its current discovery behavior. Direct package-manifest agent discovery is explicitly deferred.

The workspace will support two installation modes:

- **Development installation**: Pi loads the local checkout, allowing edits to be tested with `/reload`.
- **Bootstrap installation**: Pi installs the repository from its GitHub default branch using `pi install git:...`, allowing a new machine to use Pi's package manager for installation and updates.

Pi's machine configuration will select pnpm for managed package installs. `pi-web-access` remains a separately installed External Pi package. The Herdr-managed state extension remains outside the workspace. Migrated copies in the old runtime tree will be removed during clean cutover to prevent duplicate loading.

## User Stories

1. As the workspace maintainer, I want one Git repository to contain my authored extensions, skills, agents, documentation, tests, and development tooling, so that these resources have one source of truth.
2. As the workspace maintainer, I want runtime state to remain outside the workspace, so that credentials, sessions, caches, logs, and package-manager state are not mixed with authored source.
3. As a new-machine user, I want to install the Pi workspace from GitHub using Pi's package manager, so that I can recreate the extension setup without knowing the original checkout path.
4. As a new-machine user, I want the bootstrap instructions to support both SSH and HTTPS GitHub authentication, so that the setup works with the authentication method available on the machine.
5. As a new-machine user, I want the default GitHub installation to track the repository's default branch, so that I can update the workspace with Pi's normal extension update command without a release process.
6. As a local developer, I want Pi to load the local workspace checkout directly, so that I can edit an extension and test it without publishing or pushing a commit.
7. As a local developer, I want `/reload` to pick up extension changes, so that the edit-and-test loop remains short.
8. As a local developer, I want one pnpm installation at the workspace root, so that TypeScript, test tooling, native parser dependencies, and workspace packages resolve consistently.
9. As a local developer, I want Pi's package manager to use pnpm, so that GitHub bootstrap installations and local development use the same package-manager behavior.
10. As the workspace maintainer, I want the root aggregate package to be the single Pi installation boundary, so that I do not need to install each personal extension separately.
11. As the workspace maintainer, I want each authored extension to have a child extension package boundary, so that its dependencies, tests, and supporting source remain understandable without requiring independent publication.
12. As the workspace maintainer, I want all current authored extensions ported without feature changes, so that the migration does not change Pi behavior while improving its development structure.
13. As a Pi user, I want the bash permission extension to preserve its current allow, ask, deny, fail-closed, audit, and headless behavior, so that moving it does not weaken command safety.
14. As a Pi user, I want the bash policy to be versioned with the workspace, so that a new machine receives the same reviewed security policy as the existing machine.
15. As the workspace maintainer, I want the bash permission extension to use normal package dependencies for its native tree-sitter libraries, so that it is not tied to the old runtime directory depth.
16. As a Pi user, I want the Herdr bridge and bash permission extension to preserve the existing `herdr:blocked` event name and payload behavior, so that the externally managed Herdr state integration continues to work.
17. As the workspace maintainer, I want authored emitters to share a typed Herdr event contract, so that future source changes cannot accidentally diverge on the event name or payload shape.
18. As a Pi user, I want `herdr-agent-state.ts` to remain owned by Herdr, so that a Herdr update does not conflict with a workspace copy.
19. As a Pi user, I want session auto-naming to preserve its current model lookup, naming, sanitization, and session lifecycle behavior, so that the port is operationally invisible.
20. As a Pi user, I want `herdr-subagent` to preserve its current user-agent and project-agent discovery behavior, so that the port does not introduce a new agent scope or change project-trust semantics.
21. As the workspace maintainer, I want all 23 current skills moved without renaming or content changes, so that existing skill invocations continue to work.
22. As the workspace maintainer, I want all 5 current agents moved without changing their names, descriptions, prompts, tools, models, or extension metadata, so that delegation behavior remains stable.
23. As a Pi user, I want workspace agents to be manually copied into Pi's existing global agents directory during this migration, so that the current `herdr-subagent` implementation can remain unchanged.
24. As a Pi user, I want project-local agent precedence to remain unchanged, so that a trusted project can continue to override a global agent with the same name.
25. As a Pi user, I want migrated workspace copies to replace stale same-name global copies during clean cutover, so that the workspace is the source of truth for the agents it owns.
26. As a Pi user, I want skills in the aggregate package to be globally available, so that they work across projects as they do in the current setup.
27. As a workspace maintainer, I want `pi-web-access` to remain a separately installed External Pi package, so that this repository does not vendor or republish third-party web tooling.
28. As a user of the documentation and explanation agents, I want the bootstrap documentation to identify `pi-web-access` as a prerequisite, so that those agents do not appear installed while their referenced tools are missing.
29. As a local developer, I want the workspace to type-check against the exact installed Pi package version, so that compile-time types match the runtime API rather than relying on Pi's loader aliases.
30. As a local developer, I want the workspace to declare Node 22+ compatibility, so that it has a clear supported runtime floor while remaining usable on newer supported Node versions.
31. As a local developer, I want a root strict noEmit typecheck, so that missing Pi imports, invalid extension APIs, and cross-package type errors are caught in one command.
32. As a local developer, I want focused tests for pure policy, command extraction, and agent parsing/discovery logic, so that high-value behavior is protected without requiring a full Herdr or TUI environment.
33. As a local developer, I want extension loading smoke tests at the aggregate package boundary, so that the tests verify the same package/resource seam Pi uses rather than duplicating loader internals.
34. As a local developer, I want skills and agent frontmatter inventories checked during migration, so that missing, malformed, or accidentally renamed resources are detected.
35. As a local developer, I want no build output or source synchronization step for extensions and skills, so that Pi executes the same raw TypeScript that the workspace type-checks.
36. As a workspace maintainer, I want per-extension `node_modules` and the accidentally committed Herdr TypeScript installation removed from the authored workspace, so that dependency ownership is clear and the repository remains reproducible.
37. As a user performing clean cutover, I want migrated extension, skill, and agent copies removed from the old runtime tree, so that Pi does not load duplicate resources.
38. As a user performing clean cutover, I want unrelated Pi packages, settings, machine configuration, and the Herdr-managed state extension preserved, so that this migration does not erase unrelated personal setup.
39. As a local developer, I want update instructions for both local checkouts and Pi-managed GitHub installations, so that I know when to use `git pull`, pnpm installation, Pi update, manual agent copying, and `/reload`.
40. As the workspace maintainer, I want direct package-manifest agent discovery documented as a future improvement rather than implemented now, so that the current migration remains behavior-preserving while leaving a clear evolution path.

## Implementation Decisions

- The project root is the dedicated personal Pi repository, not the existing reference checkout used for studying `rpiv-mono`.
- The repository is a private GitHub-backed Pi workspace. It is not an npm publishing project and does not initially adopt lockstep versioning, release automation, marketing-site concerns, or public package metadata.
- The repository uses pnpm workspaces and a single root lockfile. Pi's machine configuration uses `npmCommand: ["pnpm"]` for managed package installation.
- The root package is a private aggregate Pi package. Its Pi manifest exposes the authored extension entrypoints and the root skills resource. Agents are not declared as a Pi manifest resource because Pi does not currently provide that package resource type.
- Each authored extension receives one child extension package: bash permission, Herdr subagent, Herdr bridge, and session auto-name. These are workspace boundaries for dependencies and tests, not independent release units.
- A small non-extension shared contract package defines the authored `herdr:blocked` event name and payload type. The existing runtime event contract remains unchanged.
- Extensions execute as raw TypeScript through Pi's jiti loader. The workspace has no extension build step and no `dist` output.
- Pi core development packages are pinned to the exact installed Pi version. Pi-provided packages remain host-provided at runtime rather than being bundled into the aggregate package.
- Non-Pi runtime dependencies are declared as runtime dependencies of the relevant child extension package. The bash permission package uses normal tree-sitter package versions rather than dependencies pointing into the old Pi runtime installation.
- The versioned bash policy is shipped with the bash permission package. Policy changes are security-sensitive changes and are not machine-local runtime state.
- The complete current inventory is migrated: four authored extensions, 23 skills, and 5 agents. Migration changes are mechanical: source placement, package manifests, dependency wiring, typecheck/test setup, and documentation only.
- The `herdr-agent-state` managed extension is excluded from the aggregate package. Herdr remains its source and lifecycle owner.
- Workspace agents remain in the repository as source but are manually copied into Pi's active global agent directory for this initial migration. `herdr-subagent` continues to discover user and project agents through its existing mechanism. A future package-native agent discovery feature is explicitly deferred.
- Clean cutover removes migrated copies from the previous runtime tree. It preserves unrelated packages, settings, runtime state, and externally managed resources.
- The default bootstrap installation is a global Pi package installation from the GitHub default branch. SSH and HTTPS authentication are both documented. The development installation is a global local-path package installation pointing at the working tree.
- Pi's CLI owns package installation and update lifecycle. Repository documentation describes the commands and manual agent copy, but the repository does not initially rewrite Pi settings through a custom installer.
- `pi-web-access` remains a separately installed External Pi package and is documented as a prerequisite for agents that reference its extension tools.
- The workspace targets Node 22+ and uses a root strict noEmit typecheck. It does not require a fixed absolute checkout path or a fixed Pi runtime directory.
- Extension load order and the existing Herdr event contract must be preserved during aggregate package resource declaration.

## Testing Decisions

- Good tests verify observable behavior at the highest stable seam available. They should assert decisions, registered resources, emitted event payloads, and effective discovery results rather than private helper call sequences or file layout trivia.
- The primary verification seam is the aggregate package boundary: install the workspace dependencies, load its declared resources using Pi's normal resource-loading path, and verify that the expected extension and skill resources are available.
- The root TypeScript check is a required migration gate. It covers all authored extension source, the shared event contract, test source, and relevant configuration types.
- Bash policy tests cover parsing, rule matching, agent-specific rule merging, allow/ask/deny aggregation, fail-closed behavior, and headless approval behavior. Existing manual validation coverage is retained or converted into focused tests without changing policy semantics.
- Command extraction tests cover representative shell syntax and parse failure behavior through the existing extraction seam.
- Agent discovery tests cover frontmatter parsing, the existing global/project discovery behavior, duplicate-name precedence, malformed files, and the manual-copy migration contract. They must not introduce package-native discovery behavior.
- The shared Herdr contract gets tests that verify the stable event name and payload shape used by authored emitters.
- Extension smoke tests load each authored factory through Pi's documented loader/SDK seam and verify successful registration or startup without requiring a live Herdr pane, network provider, or interactive TUI.
- Resource inventory tests verify that all 23 skill directories and 5 agent definitions are present, retain their canonical names, and preserve required frontmatter and companion files.
- Installation documentation should be manually verified in a clean temporary Pi configuration using both a local-path installation and a GitHub-style package installation. The verification should confirm no duplicate extension loading after clean cutover.
- Native tree-sitter installation is tested on the supported Node floor and the development Node version used by the maintainer, because native dependency failures must be visible before cutover.
- Full Herdr integration, provider network calls, and complete TUI interaction are not required for the initial migration gate. Their behavior is preserved by keeping the relevant source and contracts unchanged, with targeted smoke coverage where practical.

## Out of Scope

- Adding new extension, skill, or agent functionality.
- Changing extension behavior, tool schemas, event payloads, permission rules, model selection, prompts, frontmatter, or project-trust semantics.
- Implementing package-native agent discovery.
- Automatically synchronizing agents during this initial migration; manual copying is intentional for now.
- Turning the repository into a public npm package or adding release/version automation.
- Bundling or republishing `pi-web-access`, Pi core packages, or other unrelated external Pi packages.
- Moving credentials, sessions, caches, logs, auth files, model stores, or other Runtime state into the repository.
- Taking ownership of the Herdr-managed state extension.
- Moving all dotfiles-managed Pi settings, themes, or unrelated runtime resources into this repository.
- Introducing a custom installer that rewrites Pi settings.
- Reorganizing or renaming the current skills and agents during the port.
- Replacing pnpm with npm or adding a second package-manager workflow.
- Requiring a compiled JavaScript distribution or a build artifact.
- Full end-to-end testing of Herdr, network providers, or the interactive TUI.

## Further Notes

- The source of truth for workspace-owned agents is the repository, even though the initial runtime discovery copy lives in Pi's global agent directory. Manual copy instructions must make this distinction explicit.
- A clean cutover should remove old same-name global copies before copying workspace agents, so the workspace-owned definitions are not shadowed by stale dotfiles files.
- The active Pi runtime directory is selected by Pi and the machine environment. The workspace must not encode a fixed `~/.pi/agent`, `~/.config/pi/agent`, or checkout path.
- The current Pi version used for the design baseline is 0.81.1; implementation should confirm the installed version before pinning development package versions.
- `CONTEXT.md` is the glossary for the Pi workspace, while the ADRs record the accepted architecture choices and the superseded package-native agent-discovery proposal.
- This specification is intentionally local to `docs/specs` for review before implementation. It is not being published to an issue tracker at this stage.
