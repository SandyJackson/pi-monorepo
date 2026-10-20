# pi-monorepo

My Pi setup in one repo. Extensions, skills, and agents I use day to day.

## Packages

| Package | What it is |
| --- | --- |
| [bash-permission](./packages/bash-permission) | Removed for now. It used to gate bash calls against an allow, ask, deny policy. The code is still in the repo; see `docs/bash-policy.md` for how to restore it. |
| [herdr-bridge](./packages/herdr-bridge) | Emits `herdr:blocked` when a tool waits on user input, so Herdr shows it. |
| [herdr-contract](./packages/herdr-contract) | Shared event name and payload for `herdr:blocked`. |
| [herdr-subagent](./packages/herdr-subagent) | Delegates work to subagents in visible Herdr panes. |
| [session-auto-name](./packages/session-auto-name) | Names untitled sessions after the first exchange. |

Skills live in [skills](./skills). Agent definitions live in [agents](./agents). Shared vocabulary is in [GLOSSARY.md](./GLOSSARY.md).

## Installation

This repo is not published as a package. Clone it and point Pi at the local copy.

```bash
git clone git@github.com:SandyJackson/pi-monorepo.git
cd pi-monorepo
pnpm install
pi install /absolute/path/to/pi-monorepo
```

Workspace agents are discovered directly by herdr-subagent. If you previously copied them into Pi's user agent directory, follow [Remove previously copied agents](./docs/agent-discovery.md#remove-previously-copied-agents) so stale copies stop overriding the package versions.

After changing code, run `pnpm install` if dependencies changed, then `/reload` in Pi to pick it up.

## Development checks

Use Node 22.18 or newer. Run `pnpm test:fast` for routine feedback and
`pnpm check:affected` before work is ready. Pre-commit runs staged lint and
typecheck; pre-push adds fast tests and affected integration tests.

`pnpm test:issue-loop` runs the issue-loop package, and `pnpm test:all` runs
everything. Preview selection with `pnpm test:affected --list`. See
[the check policy](./docs/agents/testing.md) for comparison bases, runtime-resource
handling and when the full suite is required.
