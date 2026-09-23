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

Skills live in [skills](./skills). Agent definitions live in [agents](./agents). Shared vocabulary is in [CONTEXT.md](./CONTEXT.md).

## Installation

This repo is not published as a package. Clone it and point Pi at the local copy.

```bash
git clone git@github.com:SandyJackson/pi-monorepo.git
cd pi-monorepo
pnpm install
pi install /absolute/path/to/pi-monorepo
```

Agents need a manual copy:

```bash
cp /absolute/path/to/pi-monorepo/agents/*.md ~/.config/pi/agent/agents/
```

After changing code, run `pnpm install` if dependencies changed, then `/reload` in Pi to pick it up.
