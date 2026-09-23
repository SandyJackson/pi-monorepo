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

**Visible subagent**:
A child Pi agent operating in a Herdr-managed pane, where its work remains observable and can be taken over interactively.

**Visible subagent session**:
The persistent Pi session hosting a visible subagent. A session may outlive an individual delegated task and support later turns.

**Subagent delegation**:
A request from a parent Pi session to execute one or more delegated tasks as visible subagents. The delegation is distinct from each individual task it contains.

**Delegated task**:
One turn assigned to a visible subagent, consisting of an agent, instruction, and optional working-directory selection. The task settles independently of the lifetime of its visible subagent session.

**Delegated task number**:
The one-based position assigned once to a delegated task within its subagent delegation. It is the task's canonical identity throughout that delegation; the visible subagent session reference identifies the persistent session beyond it.

**Delegated task outcome**:
The single terminal result of a delegated task, such as completion, timeout, abort, session closure, or an execution failure. Outcomes retain the order and delegated task numbers of their tasks.

**Bash policy**:
The versioned set of rules that determines whether a bash command is allowed, requires approval, or is denied for the workspace and its agents.

**Herdr blocked event**:
The event-bus contract emitted by authored extensions when a user interaction is blocking progress, allowing the managed Herdr integration to reflect that state.

**External Pi package**:
A separately installed third-party Pi package that is not owned by the Pi workspace but may be required by a workspace resource, such as an agent's extension-tool references.

## Worktree switching

**Worktrunk extension**:
The workspace extension package that relocates the active Pi session between Git worktrees using the Worktrunk CLI. It does not create, merge, or remove worktrees; Worktrunk owns that lifecycle.

**Worktree relocation**:
Moving the active Pi conversation into a different worktree by replacing the session runtime with a session whose recorded cwd is the target worktree. Uncommitted changes stay in the originating worktree.

**Continuity move**:
A worktree relocation that carries the active conversation into the target session. The default relocation behavior; resuming a pre-existing target session is a future option, not a relocation mode.

**Creation switch**:
A worktree relocation combined with creating a new Worktrunk worktree and branch. The new branch is based on the repository's default branch as chosen by Worktrunk.

**Relocation note**:
A context-visible message queued at the next prompt after a worktree relocation, telling the model it now operates in the target worktree. It does not trigger a turn.

**Recovery worktree**:
The main checkout recorded by the Worktrunk extension at session start, used to relocate the session when the current worktree directory no longer exists.

## Installation modes

**Development installation**:
A Pi installation that loads the Pi workspace from a local working tree so source changes can be tested with `/reload` without publishing or pushing them.

**Bootstrap installation**:
A Pi installation created from the workspace's GitHub package source, allowing a new machine to clone, install, and update the Pi resources through Pi's package manager.

**Workspace agent**:
An agent definition owned by the Pi workspace and synchronized into Pi's existing global agent directory for runtime discovery. It is distinct from project-local agents; when names collide, project agents override workspace agents, which override user agents.

**Callable agent catalog**:
The session-scoped snapshot of agent definitions available for subagent delegation. It combines global discovery with trusted project-local overrides and refreshes with Pi's session lifecycle.
