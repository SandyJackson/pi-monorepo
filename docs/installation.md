# Installation & Setup

This workspace provides Pi extensions, skills, and agents as a pnpm package.
It supports two installation modes: **local development** (symlink) and **GitHub bootstrap** (clone + install).

## Prerequisites

- Node.js >= 22
- pnpm (for local development only; Pi bundles its own pnpm)
- Git (for GitHub installation)
- [pi-web-access](https://github.com/earendil-works/pi-web-access) (separate package, required by `docs-researcher` and `explain` agents)

## Local Development Installation

Use this mode when you are actively developing extensions, skills, or agents in this repository.

```bash
# 1. Clone the repository
git clone https://github.com/earendil-works/pi-monorepo.git
cd pi-monorepo

# 2. Install dependencies
pnpm install

# 3. Install into Pi (adds to ~/.config/pi/agent/settings.json)
pi install /absolute/path/to/pi-monorepo
```

Pi will show the workspace in `pi list`:

```
User packages:
  /absolute/path/to/pi-monorepo
    /absolute/path/to/pi-monorepo
```

### Updating during development

```bash
cd /absolute/path/to/pi-monorepo
pnpm install          # pull new dependencies if package.json changed
# Then in Pi:
/reload               # picks up code changes without restarting
```

## GitHub Bootstrap Installation

Use this mode to install the workspace on a new machine without cloning the repo for development.

### HTTPS

```bash
pi install https://github.com/earendil-works/pi-monorepo
```

### SSH

```bash
pi install git:git@github.com:earendil-works/pi-monorepo.git
```

Pi clones the repository into its managed package store and resolves extensions from the default branch.

### Updating from GitHub

```bash
pi update             # pulls latest default branch for all installed packages
/reload               # applies changes to the running session
```

## pi-web-access (External Dependency)

The `docs-researcher` and `explain` agents require the `pi-web-access` package, which is maintained separately.
Install it alongside this workspace:

```bash
pi install npm:pi-web-access
```

`pi-web-access` is **not** vendored or republished by this workspace.

## Agent Setup

Installing the aggregate package makes workspace agents callable through `herdr-subagent` directly from the package. No copy step is required.

For migration from manually copied agents, follow [Remove previously copied agents](./agent-discovery.md#remove-previously-copied-agents). Delete those stale copies from Pi's user agent directory or they will keep overriding the package versions. That guide also covers deliberate user overrides and directory symlinks.

## Package Manager Configuration

Pi uses pnpm internally to manage package installation and dependency resolution.
Key configuration:

- **Global installation scope**: Packages are installed to `~/.config/pi/agent/` (user scope)
- **Project installation scope**: Packages can be installed locally to `.pi/settings.json` (project scope)
- **Default-branch updates**: `pi update` pulls the latest default branch for all git-sourced packages
- **`/reload`**: Reloads extensions, skills, and prompts without restarting the Pi session

## What Gets Loaded

The workspace exposes these resources through its `package.json`:

| Resource type | Entry point | Contents |
|---|---|---|
| Extensions | `pi.extensions` array | 5 child packages (bash-permission, herdr-subagent, herdr-bridge, session-auto-name, herdr-contract) |
| Skills | `pi.skills` array | `skills/` directory with 23 skills |
| Agents | `agents/` directory | Workspace definitions discovered by herdr-subagent |
| Documentation | `docs/` directory | Bash policy, agent discovery, installation guide |

## Cutover from Old Runtime

If migrating from a previous dotfiles-based installation:

1. **Install the workspace** using one of the methods above
2. Follow [Remove previously copied agents](./agent-discovery.md#remove-previously-copied-agents) to remove stale workspace copies from the user agent directory.
3. **Remove migrated resources** from the old location:
   - Delete `~/.config/pi/agent/extensions/bash-permission/`
   - Delete `~/.config/pi/agent/extensions/herdr-subagent/`
   - Delete `~/.config/pi/agent/extensions/herdr-bridge.ts`
   - Delete `~/.config/pi/agent/extensions/session-auto-name.ts`
   - Delete migrated skill directories from `~/.config/pi/agent/skills/`
4. **Keep these intact** (do not remove):
   - `~/.config/pi/agent/extensions/herdr-agent-state.ts` (managed by Pi)
   - `~/.config/pi/agent/settings.json` (your configuration)
   - `~/.config/pi/agent/auth.json` (authentication)
   - `~/.config/pi/agent/models.json` (model catalog)
   - `~/.config/pi/agent/trust.json` (project trust decisions)
   - npm packages in `~/.config/pi/agent/npm/` (e.g., pi-web-access)
5. **Restart Pi** or run `/reload`
6. **Verify** with `pi list` that the workspace appears
