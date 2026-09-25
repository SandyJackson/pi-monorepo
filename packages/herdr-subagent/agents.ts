/**
 * agents.ts — Agent discovery and frontmatter parsing for herdr-subagent.
 *
 * Discovers user-level agents from Pi's agent directory and, when scope
 * permits, project-level agents from `.pi/agents/` walking up from cwd.
 *
 * Uses Pi's built-in `parseFrontmatter` for correct YAML frontmatter parsing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * NOTE: `packages/issue-loop` reuses `ParsedAgentFile` and
 * `parseAgentFileContent` for its `--settings` role files.
 */

/** Which agent directories to search. */
export type AgentScope = "user" | "project" | "both";

/**
 * An agent definition parsed from a single markdown file, without any
 * directory-scoping metadata. This is the unit shared with `issue-loop`:
 * unlike `AgentConfig`, it carries no `source`/`sourceDir`/`filePath` and
 * imposes no required `description`.
 */
export interface ParsedAgentFile {
  /** Agent name (frontmatter `name` or filename without `.md`). */
  name: string;
  /** Description from frontmatter (may be empty; only discovery requires it). */
  description: string;
  /**
   * Tool allowlist from the frontmatter `tools` field.
   * `undefined` means the field was absent. An explicitly empty list means
   * "no restriction requested". Callers decide what absence implies:
   * subagent discovery falls back to Pi's default toolset, while the issue
   * loop falls back to its per-role restrictions.
   */
  tools?: string[];
  /** Model override from frontmatter `model`; `undefined` means Pi's default. */
  model?: string;
  /** Thinking-level override from frontmatter `thinking`; `undefined` means Pi's default. */
  thinking?: string;
  /** Body text after frontmatter (role guidance for the system prompt). */
  systemPromptBody: string;
}

/** Normalize one agent file's frontmatter and body into a `ParsedAgentFile`. */
export function parseAgentFileContent(content: string, fallbackName: string): ParsedAgentFile {
  const parsed = parseFrontmatter<Record<string, unknown>>(content);
  const frontmatter = parsed.frontmatter;
  const body = parsed.body;
  const name =
    typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
      ? frontmatter.name.trim()
      : fallbackName;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const toolsRaw = frontmatter.tools;
  let tools: string[] | undefined;
  if (typeof toolsRaw === "string") {
    const items = toolsRaw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    tools = items.length > 0 ? items : [];
  } else if (Array.isArray(toolsRaw)) {
    tools = toolsRaw
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  const modelRaw = frontmatter.model;
  const model =
    typeof modelRaw === "string" && modelRaw.trim().toLowerCase() !== "none"
      ? modelRaw.trim()
      : undefined;
  const thinkingRaw = frontmatter.thinking;
  const thinking =
    typeof thinkingRaw === "string" && thinkingRaw.trim().toLowerCase() !== "none"
      ? thinkingRaw.trim()
      : undefined;
  return { name, description, tools, model, thinking, systemPromptBody: body.trim() };
}

/** A resolved agent definition from a markdown file. */
export interface AgentConfig {
  /** Canonical agent name (frontmatter `name` or filename without `.md`). */
  name: string;
  /** Description from frontmatter. */
  description: string;
  /**
   * Tool allowlist from the frontmatter `tools` field.
   * `undefined` or empty array means "use Pi's default toolset" (no restriction
   * passed via `--tools`, so the child gets Pi's standard built-in tools).
   * Values are matched against Pi's tool registry by exact registered name —
   * plain built-in names (`read`, `bash`, ...) and plain extension tool names
   * (`web_search`, ...). There is no `ext:<package>/<tool>` syntax; unknown
   * names are silently ignored. To disable all built-in tools while keeping
   * extension tools, list the extension tool names explicitly, e.g.
   * `tools: web_search` (only that extension tool).
   */
  tools?: string[];
  /**
   * Model override from frontmatter `model` field, e.g. "openai-codex/gpt-5.5".
   * `undefined` means "use Pi's default model".
   */
  model?: string;
  /** Body text after frontmatter (appended as system prompt in child pane). */
  systemPromptBody: string;
  /** Whether the agent was loaded from the user or project directory. */
  source: "user" | "project";
  /** Absolute path to the directory containing the agent file. */
  sourceDir: string;
  /** Absolute path to the agent file. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const AGENTS_DIR_NAME = "agents";

/** Load agent definitions from a single directory. */
function loadFromDir(dirPath: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dirPath, entry);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    let parsed: ParsedAgentFile;
    try {
      parsed = parseAgentFileContent(content, path.basename(filePath, ".md"));
    } catch {
      // Malformed frontmatter — skip this file
      continue;
    }

    // Skip files that don't declare a description
    if (!parsed.description) continue;

    agents.push({
      name: parsed.name,
      description: parsed.description,
      tools: parsed.tools,
      model: parsed.model,
      systemPromptBody: parsed.systemPromptBody,
      source,
      sourceDir: dirPath,
      filePath,
    });
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}

/** Check if a path is an existing directory. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover user-level agents from Pi's global agent directory
 * (`~/.config/pi/agent/agents/`).
 */
export function discoverUserAgents(): AgentConfig[] {
  const agentDir = getAgentDir();
  const agentsDir = path.join(agentDir, AGENTS_DIR_NAME);
  return loadFromDir(agentsDir, "user");
}

/**
 * Walk up from `cwd` looking for a `.pi/agents/` directory containing
 * agent markdown files. Returns the agents from the **first** such
 * directory found (closest ancestor), or an empty array.
 */
export function discoverProjectAgents(cwd: string): AgentConfig[] {
  let current = path.resolve(cwd);
  for (;;) {
    const agentsDir = path.join(current, CONFIG_DIR_NAME, AGENTS_DIR_NAME);
    if (isDirectory(agentsDir)) {
      const agents = loadFromDir(agentsDir, "project");
      if (agents.length > 0) return agents;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }
  return [];
}

/**
 * Resolve an agent by name from a previously merged agent list.
 *
 * Returns the matched AgentConfig, or an error object with a formatted
 * message listing all available agents in the requested scope.
 */
export function resolveAgent(
  name: string,
  agents: AgentConfig[],
  scope: AgentScope,
): AgentConfig | { error: string } {
  const config = agents.find((agent) => agent.name === name);

  if (!config) {
    if (agents.length === 0) {
      return {
        error:
          `No agents found in scope "${scope}". ` +
          `Expected agent files in ${scope === "project" ? `the nearest ${CONFIG_DIR_NAME}/agents/ directory` : `${path.join(getAgentDir(), AGENTS_DIR_NAME)}/`}.`,
      };
    }
    return {
      error: `Unknown agent "${name}". Available agents:\n${formatMergedAgentList(agents)}`,
    };
  }

  return config;
}

/**
 * Merge user and project agent lists, with project agents overriding user
 * agents of the same name. Returns a flat, de-duplicated array.
 */
export function mergeAgentLists(
  userAgents: AgentConfig[],
  projectAgents: AgentConfig[],
): AgentConfig[] {
  const map = new Map<string, AgentConfig>();
  for (const agent of userAgents) map.set(agent.name, agent);
  for (const agent of projectAgents) map.set(agent.name, agent);
  return Array.from(map.values()).sort((leftAgent, rightAgent) =>
    leftAgent.name.localeCompare(rightAgent.name),
  );
}

/**
 * Format a merged agent list without source labels.
 * Suitable for model-facing descriptions and no-task listings.
 */
export function formatMergedAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents
    .map((agent) => {
      const desc = agent.description ? ` — ${agent.description}` : "";
      return `  ${agent.name}${desc}`;
    })
    .join("\n");
}
