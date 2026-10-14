# Agent Discovery

Pi discovers agents from the `agents/` directory in the agent directory (typically `~/.config/pi/agent/agents/` or `~/.pi/agent/agents/`).

## How Pi Discovers Agents

1. Pi looks for `.md` files in the `agents/` directory
2. Each `.md` file is parsed for YAML frontmatter containing:
   - `description` - Agent description
   - `display_name` - Display name
   - `tools` - Tool allowlist
   - `model` - Model override
   - `thinking` - Thinking level passed to visible subagents as `--thinking`; omitted to use Pi's default
   - `timeout` - Optional positive integer number of minutes for the agent's default delegation timeout
   - `extensions` - Required extensions
3. The body of the markdown file is used as the system prompt

For `herdr-subagent`, the call's `timeout` overrides each agent's frontmatter `timeout`. An agent without a timeout uses the 60-minute default. Invalid frontmatter timeouts stop discovery with an error naming the file and the positive-integer requirement.

## Manual Copy Instructions

To use agents from this workspace in your Pi installation:

### Option 1: Copy Individual Agents

```bash
# Copy a specific agent
cp /path/to/pi-monorepo/agents/code-reviewer.md ~/.config/pi/agent/agents/

# Copy all agents
cp /path/to/pi-monorepo/agents/*.md ~/.config/pi/agent/agents/
```

### Option 2: Symlink (for development)

```bash
# Symlink the entire agents directory
ln -sf /path/to/pi-monorepo/agents ~/.config/pi/agent/agents
```

### Option 3: Use Pi's Package System

If using a Pi package, agents are discovered from the package's `agents/` directory.

## Agent File Format

Each agent file is a markdown file with YAML frontmatter:

```markdown
---
description: Agent description
display_name: Agent Name
tools: read, grep, find, ls, bash
model: openai-codex/gpt-5.6-sol
thinking: high
timeout: 90
extensions:
  - bash-permission
---

System prompt content goes here...
```

## Available Agents

| Agent | Description |
|-------|-------------|
| code-reviewer | Read-only code/PR review |
| codebase-analyser | Explains how existing code works |
| docs-researcher | Researches current documentation |
| explain | Explains concepts and tradeoffs |
| refactor | Refactors existing code for clarity |
