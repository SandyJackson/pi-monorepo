# Bash Permission Policy

> The `bash-permission` extension is currently removed. Nothing enforces the rules below. The code still lives in `packages/bash-permission/`.

## Restoring it

1. Re-add the load entry in `package.json` under `pi.extensions`:

```json
"./packages/bash-permission/index.ts"
```

2. Re-add the dependency in `package.json` and install:

```json
"@pi-workspace/bash-permission": "workspace:*"
```

```bash
pnpm install
```

3. Re-add `bash-permission` to the `extensions:` frontmatter in `agents/code-reviewer.md`, `agents/codebase-analyser.md`, `agents/implement.md`, and `agents/docs-researcher.md`.
4. Restore the `@pi-workspace/bash-permission` assertion in `package.test.ts`.
5. Run `/reload` in Pi.

This file documents the bash permission rules enforced by the `bash-permission` extension.

## Where the config lives

The extension is defined in the repository at `llm-tooling/pi/agent/extensions/bash-permission/` and deployed to `~/.config/pi/agent/extensions/bash-permission/`. Pi auto-discovers extensions in `~/.config/pi/agent/extensions/` (or `~/.pi/agent/extensions/` for older installs), so no explicit path is needed in `settings.json`.

The policy config file is at `extensions/bash-permission/bash-permission.json` (same path in both repo and deployed copy). If the config is missing or invalid, the extension denies all bash commands (fail-closed).

## Architecture

### Rule evaluation

Rules are evaluated as a flat list, **last match wins**:

1. Global rules are loaded first (from the `bash` map at the top of `bash-permission.json`).
2. Per-agent overrides are loaded next (from `agents.<name>.bash`).
3. The lists are concatenated — global rules first, then per-agent rules.
4. Each extracted command unit is tested against every rule in order; the last matching rule determines the action.

This means per-agent rules naturally override global rules. An agent can both tighten global defaults (deny-all + narrow allowlist) and relax them (allow something the global policy denies).

### Evaluation flow

For each bash call:
1. **Extract** command units via tree-sitter (fail-closed on parse failure)
2. **Evaluate** each unit against the merged rule list → `allow`, `ask`, or `deny`
3. **Aggregate**: any deny → deny whole call; no deny but any ask → prompt user; all allow → allow
4. Headless mode: `ask` resolves to `deny`

### Tool-level gating

Whether an agent gets `bash` at all is controlled by the `tools:` field in the agent's markdown frontmatter. Agents without `bash` in their tools cannot execute shell commands regardless of policy. The `bash-permission` extension merely gates *already-available* bash access; it does not grant bash to agents that lack the tool.

## Why bash-capable agents must declare the extension

Pi subagents can load a subset of extensions based on the `extensions:` field in their agent markdown frontmatter. If a bash-capable agent does **not** list `bash-permission` in its `extensions:`, then:
- The bash-permission extension is **not loaded** for that agent.
- The bash tool runs without permission controls — no wrapping, no enforcement, no audit.

To ensure coverage, every agent whose `tools:` list includes `bash` must also include `bash-permission` in its `extensions:` list:

```yaml
---
tools: read, grep, find, ls, bash
extensions: [bash-permission]
---
```

Agents without `bash` in their tools can omit `bash-permission` entirely or use `extensions: false`.

### Current agent coverage

| Agent | Has bash? | Extensions |
|---|---|---|
| `main` (default) | Yes (default Pi tool) | Auto-loaded via auto-discover |
| `code-reviewer` | Yes | `[bash-permission]` |
| `codebase-analyser` | Yes | `[bash-permission]` |
| `docs-researcher` | Yes | `[pi-web-access, bash-permission]` |
| `explain` | No | `[pi-web-access]` |
| `refactor` | No | `false` |

## Agent bash policies

### Main session (global defaults)

Broad permissive defaults modelled on opencode's approach. Covers:
- File reading: `bat`, `cat`, `head`, `tail`, `ls`, `file`, `wc`, `which`
- Fast search: `rg`, `fd`, `grep`, `find`, `jq`
- Text processing: `cut`, `diff`, `sort`, `tr`, `uniq`
- File operations: `cp`, `mv`, `mkdir`, `touch`, `ln`, `cd`, `echo`
- Network: `curl`, `gh`
- Package/tool management: `bun`, `npm`, `npx`, `pip`, `uv`
- Building: `make`, `cmake`
- Archives: `tar`, `zip`, `unzip`, `gzip`
- Utilities: `tree`, `man`, `date`, `env`, `printenv`, `pwd`
- Git: all subcommands allowed except `git push`

Everything not listed defaults to `ask`. `git push *` is explicitly denied.

### `code-reviewer`

Tight git-inspection-only policy matching opencode's code-reviewer permission block:
- `git diff*` — view diffs (any form)
- `git log*` — view history (any form)
- Everything else denied by default.

### `codebase-analyser`

Read-only file inspection and git history for understanding how code works:
- File reading: `bat`, `cat`, `head`, `tail`, `ls`, `file`, `wc`, `which`
- Fast search: `rg`, `fd`, `grep`, `find`, `jq`
- Text processing: `cut`, `diff`, `sort`, `tr`, `uniq`
- Git history: `git diff *`, `git log *`, `git show *`, `git blame *`, `git status`
- Utilities: `man`, `pwd`
- Everything else denied by default.

### `docs-researcher`

Same as codebase-analyser, plus `curl` for fetching documentation from endpoints:
- File reading: `bat`, `cat`, `head`, `tail`, `ls`, `file`, `wc`, `which`
- Fast search: `rg`, `fd`, `grep`, `find`, `jq`
- Text processing: `cut`, `diff`, `sort`, `tr`, `uniq`
- Git history: `git diff *`, `git log *`, `git show *`, `git blame *`, `git status`
- Network: `curl`
- Utilities: `man`, `pwd`
- Everything else denied by default.

## Hidden skill command needs

Former opencode commands run in the parent session, not necessarily inside a subagent. The global policy should cover their expected commands:

- `/skill:fixtext` and `/skill:plantest`: `uv run pytest`
- `/skill:rvcommit`: `git log ... -p`
- `/skill:code-review`: `git rev-parse ...`, `git diff ...`, `git log ...`
- `/skill:setup-matt-pocock-skills`: `git remote -v`, read-only repository inspection

## General deny patterns (enforced by policy rules)

Commands matching these patterns will prompt or be denied because they're not in the allow lists:

- Shell metacharacter pipelines that hide writes or destructive subcommands
- Commands containing output redirection to non-temp paths
- Commands operating under `.git/` internals directly
- Commands modifying files outside the current workspace unless explicitly requested
- Long-running daemons or watchers
- Any command with secrets in arguments
