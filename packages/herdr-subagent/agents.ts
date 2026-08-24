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
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Which agent directories to search. */
export type AgentScope = "user" | "project" | "both";

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
	 * To disable all built-in tools while keeping extension tools, declare
	 * `tools: ext:some-tool` (only extension tools).
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

		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch {
			// Malformed frontmatter — skip this file
			continue;
		}

		// Derive name: frontmatter takes precedence, fall back to filename
		const name =
			typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
				? frontmatter.name.trim()
				: path.basename(filePath, ".md");

		const description =
			typeof frontmatter.description === "string"
				? frontmatter.description.trim()
				: "";

		// Skip files that don't declare a description
		if (!description) continue;

		const toolsRaw = frontmatter.tools;
		let tools: string[] | undefined;

		if (typeof toolsRaw === "string") {
			const parsed = toolsRaw
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
			tools = parsed.length > 0 ? parsed : [];
		} else if (Array.isArray(toolsRaw)) {
			const parsed = toolsRaw.filter(
				(item): item is string => typeof item === "string" && item.trim().length > 0,
			).map((item) => item.trim());
			tools = parsed.length > 0 ? parsed : [];
		}

		const modelRaw = frontmatter.model;
		const model =
			typeof modelRaw === "string" && modelRaw.trim().toLowerCase() !== "none"
				? modelRaw.trim()
				: undefined;

		agents.push({
			name,
			description,
			tools,
			model,
			systemPromptBody: body.trim(),
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
				error: `No agents found in scope "${scope}". ` +
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
	return Array.from(map.values()).sort((leftAgent, rightAgent) => leftAgent.name.localeCompare(rightAgent.name));
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
