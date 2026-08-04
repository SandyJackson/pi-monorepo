# Personal Pi Workspace

This context defines the vocabulary for the hand-authored Pi resources and their local deployment.

## Repository

**Pi workspace**:
The Git repository containing hand-authored extensions, skills, agents, tests, and development tooling. It is separate from Pi's runtime directory and is not required to be an npm-published package.

**Pi workspace installation**:
The machine-specific wiring that makes Pi load the Pi workspace's extensions, skills, and agents. It does not include Pi credentials, sessions, caches, or unrelated personal resources.

**Runtime state**:
Machine-local Pi data such as credentials, sessions, caches, logs, and package-manager state. It is not source-controlled by the Pi workspace.

## Workspace structure

**Aggregate package**:
The root Pi package installed by Pi in either development or bootstrap mode. It exposes the workspace's extensions and skills and provides the shared workspace boundary.

**Extension package**:
A child workspace package containing one extension entrypoint, its supporting source, tests, and runtime dependencies. It is a development boundary, not necessarily an independently installable package.

**Managed extension**:
An extension whose source and lifecycle are owned by an external integration. The Pi workspace may depend on its events or behavior but does not install, update, or overwrite it.

**Bash policy**:
The versioned set of rules that determines whether a bash command is allowed, requires approval, or is denied for the workspace and its agents.

**Herdr blocked event**:
The event-bus contract emitted by authored extensions when a user interaction is blocking progress, allowing the managed Herdr integration to reflect that state.

**External Pi package**:
A separately installed third-party Pi package that is not owned by the Pi workspace but may be required by a workspace resource, such as an agent's extension-tool references.

## Installation modes

**Development installation**:
A Pi installation that loads the Pi workspace from a local working tree so source changes can be tested with `/reload` without publishing or pushing them.

**Bootstrap installation**:
A Pi installation created from the workspace's GitHub package source, allowing a new machine to clone, install, and update the Pi resources through Pi's package manager.

**Workspace agent**:
An agent definition owned by the Pi workspace and synchronized into Pi's existing global agent directory for runtime discovery. It is distinct from project-local agents; when names collide, project agents override workspace agents, which override user agents.
