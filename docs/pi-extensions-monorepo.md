# Pi custom extensions monorepo research

## Recommendation

A private npm-workspaces monorepo is a good fit for the four hand-authored extensions. Use `rpiv-mono` as the tooling model, `agent-stuff` as the Pi package-manifest model, and keep the deployed `~/.config/pi/agent` tree separate from source code and mutable runtime state.

Do not move the whole `agent/` directory into the monorepo. It currently mixes source extensions with settings, sessions, auth/state, managed Herdr output, skills, and an npm installation root.

## Evidence from the current extensions

Source tree: `/Users/sandyjackson/code/dotfiles/llm-tooling/pi/agent/extensions/`.

- `herdr-subagent` has a strict `tsconfig.json`, but its package only installs TypeScript and Node types. `tsc -p tsconfig.json` currently fails because `@earendil-works/pi-coding-agent` and `typebox` are not installed for the compiler. Pi can still run it because the extension loader supplies virtual aliases for Pi's bundled modules.
- `bash-permission/package.json` uses `file:../../npm/node_modules/...` dependencies for `tree-sitter` and `tree-sitter-bash`. This couples the extension to the current `agent/extensions/bash-permission` depth and to the deployed `agent/npm` tree.
- `herdr-bridge.ts` and `session-auto-name.ts` are loaded through extension auto-discovery rather than the explicit `settings.json` list. The effective extension set is therefore not represented by `settings.json` alone.
- `herdr-agent-state.ts` is explicitly marked as Herdr-managed and overwritten by the integration. It should be treated as generated/external deployment output rather than normal hand-authored source.
- The repo and `~/.config/pi/agent` are independent copies, which creates drift risk.
- `bash-permission` and `herdr-bridge` communicate with `herdr-agent-state` through the `herdr:blocked` event contract, so extension loading and deployment need to preserve that contract.

## Official Pi architecture

Primary sources, installed Pi 0.81.1:

- `@earendil-works/pi-coding-agent/README.md`, sections **Extensions** and **Pi Packages**
- `docs/extensions.md`, sections **Extension Locations**, **Available Imports**, **Writing an Extension**, and **Extension Styles**
- `docs/packages.md`, sections **Creating a Pi Package**, **Dependencies**, and **Local Paths**
- `docs/sdk.md`, section **Extensions**
- `examples/extensions/with-deps/`

Important facts:

1. Extensions are default-exported TypeScript factories loaded directly by jiti. A build step is not required.
2. Pi supports package manifests using `package.json`'s `pi` key, including `pi.extensions`, `skills`, `prompts`, and `themes` paths. Conventional directories are also supported.
3. A package can be loaded from a local absolute/relative path. This is preferable for development because Pi loads the working tree rather than a copied deployment tree.
4. Pi-provided imports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) are runtime-provided and should be peer dependencies for distributable packages. They still need to be installed as development dependencies somewhere visible to TypeScript.
5. Non-Pi runtime dependencies belong in `dependencies`, not `devDependencies`, because package installation uses production installs by default.
6. `DefaultResourceLoader` plus `additionalExtensionPaths`/`extensionFactories` is the documented SDK seam for programmatic extension loading and integration tests.
7. Extension factories must defer long-lived resources until `session_start` and clean them up in `session_shutdown`.

## Comparison repositories

### `cloned_extensions/agent-stuff`

`agent-stuff` is a single Pi package with raw `.ts` extensions, a `pi` manifest, and Pi core packages as peer dependencies. It has no TypeScript config, build, or test workflow. It is useful as the minimal packaging model, but not as the development-tooling model.

### `cloned_extensions/rpiv-mono`

`rpiv-mono` is the closest structural example:

- root npm workspaces (`packages/*`)
- one root `tsconfig.base.json` with strict `noEmit` checking
- one root Vitest and formatter/linter configuration
- raw TypeScript shipped without a build directory
- each Pi package has a `pi` manifest and Pi core packages as `"*"` peer dependencies
- third-party runtime dependencies are package dependencies
- private packages and shared test utilities coexist with distributable packages

Its publishing, lockstep versioning, release automation, coverage thresholds, and CI are more than this private four-extension repo needs initially.

## Recommended target layout

```text
pi-extensions/
├── package.json              # private workspace + aggregate Pi package manifest
├── package-lock.json         # only lockfile
├── tsconfig.json             # strict root noEmit check
├── vitest.config.ts
├── biome.json                # optional initially
├── packages/
│   ├── bash-permission/
│   │   ├── package.json
│   │   ├── index.ts
│   │   ├── lib/
│   │   ├── bash-permission.json
│   │   └── *.test.ts
│   ├── herdr-subagent/
│   │   ├── package.json
│   │   ├── index.ts
│   │   └── *.test.ts
│   ├── herdr-bridge/
│   │   ├── package.json
│   │   └── index.ts
│   └── session-auto-name/
│       ├── package.json
│       └── index.ts
└── docs/
```

The root `pi.extensions` manifest should list the four actual entrypoints explicitly (or use a carefully constrained `./packages/*/index.ts` glob). Each child package may also have its own `pi` manifest so it remains independently loadable.

Keep `herdr-agent-state` outside the normal workspace package set unless its generation/ownership changes. Deploy it explicitly from the Herdr integration and do not let a source checkout silently replace it.

## Root tooling

Use one root install and one root typecheck. The root development dependencies should include the exact Pi version used at runtime:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`
- `typebox`
- `typescript`
- `@types/node`
- `vitest` if tests are added

Each extension package should declare Pi packages as `peerDependencies` (usually `"*"` for a Pi package) and declare actual runtime libraries in `dependencies`. Replace the bash extension's depth-dependent `file:` tree-sitter dependencies with normal package versions. Do not commit per-extension `node_modules`; the current tracked Herdr TypeScript install should be removed when migrating.

A minimal initial script set is:

```text
check: tsc --noEmit
 test: vitest run
 format/check: formatter or Biome check
```

No build script is needed. TypeScript should check source against the installed Pi public types rather than against Pi's internal bundled aliases.

## Deployment model

Leave `llm-tooling/pi/agent` responsible for runtime configuration and mutable state: `settings.json`, auth, models, sessions, skills, agents, themes, logs, and package installs.

Add the local monorepo as one Pi package source in settings, for example through `pi install /path/to/pi-extensions` or a local package entry. Remove old copied extension files from the auto-discovered `agent/extensions` directory before enabling the package, otherwise extensions may load twice.

Preserve explicit ordering in the aggregate manifest because the Herdr extensions share an event-bus protocol. Keep the Herdr-managed file separate and verify the final load list with a clean runtime directory.

## Testing strategy

- Unit test pure policy and parsing modules directly, especially `bash-policy` and command extraction.
- Use the SDK's `DefaultResourceLoader` with `additionalExtensionPaths` or inline factories for extension loading smoke tests.
- Use in-memory sessions and a temporary `PI_CODING_AGENT_DIR`/HOME for tests that touch Pi state.
- Run a small `pi -e` smoke test for each entrypoint and `/reload` during development.
- Add integration coverage for the `herdr:blocked` event contract and for the bash gate in UI and headless modes.

## Main risks

1. Duplicate loading during migration.
2. Breaking the Herdr-managed/generated extension boundary.
3. Native `tree-sitter` installation across Node versions.
4. Accidentally putting runtime dependencies in `devDependencies`.
5. Type-checking against a Pi version different from the installed runtime.
6. Treating all fifteen-package `rpiv-mono` release machinery as necessary for a private workspace.

## Agreed direction after grilling

- The project root is `/Users/sandyjackson/code/pi-dev/pi-monorepo`, not `cloned_extensions/rpiv-mono`.
- This is a private GitHub-backed Pi workspace, not an npm publishing project.
- It owns all current authored extensions, 23 skills, 5 agents, authored guidance, tests, and development tooling; the Herdr-managed state extension remains external.
- It uses a root aggregate Pi package plus one child workspace package per extension, with `skills/` and `agents/` at the root.
- It supports local-path development and GitHub default-branch bootstrap installations.
- Pi performs installation and update lifecycle; setup documentation does not rewrite settings. Agents are manually copied into Pi's global `agents/` directory for now.
- The migration is mechanical and behavior-preserving. No new runtime agent-discovery feature is included.
- `herdr-agent-state.ts` remains managed by Herdr and outside this workspace.
- The bash policy is versioned with the workspace; the `herdr:blocked` contract gets a small shared authored package.
- pnpm is the workspace package manager, and Pi's global `npmCommand` is configured as `["pnpm"]`.
- Pi core development types are pinned to the installed Pi version; the workspace targets Node 22+ with focused tests and a root strict typecheck.
- `pi-web-access` remains a separately installed external Pi package.
