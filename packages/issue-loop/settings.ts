/**
 * settings.ts — Optional `--settings` role configuration for the issue loop.
 *
 * A settings file is a JSON object whose agent fields reference agent-format
 * markdown files (YAML frontmatter `model`/`tools` plus a prompt body).
 */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { type ParsedAgentFile, parseAgentFileContent } from "@pi-workspace/herdr-subagent/agents";

/** Tool allowlist used when the implement agent file omits `tools`. */
export const DEFAULT_IMPLEMENT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/** Tool allowlist used when the review agent file omits `tools`. */
export const DEFAULT_REVIEW_TOOLS = ["read", "grep", "find", "ls"];

/** Resolved configuration for one loop role. Plain data: safe to snapshot into state.json. */
export interface RoleSettings {
  agentName?: string;
  model?: string;
  tools: string[];
  /** Custom role guidance; `undefined` means the runner's built-in default. */
  promptBody?: string;
}

/** Resolved settings snapshot stored with the run; `resume` reuses it verbatim. */
export interface LoopSettings {
  implement: RoleSettings;
  review: RoleSettings;
  appendSystemPrompt?: string;
}

function readAgent(role: string, settingsDir: string, ref: unknown): RoleSettings {
  const defaults = role === "review" ? DEFAULT_REVIEW_TOOLS : DEFAULT_IMPLEMENT_TOOLS;
  if (ref === undefined) {
    return { agentName: undefined, model: undefined, tools: [...defaults], promptBody: undefined };
  }
  if (typeof ref !== "string" || !ref.trim()) throw new Error(`"${role}Agent" must be a file path`);
  const filePath = resolve(settingsDir, ref);
  let agent: ParsedAgentFile;
  try {
    agent = parseAgentFileContent(readFileSync(filePath, "utf8"), basename(filePath, ".md"));
  } catch (error) {
    throw new Error(
      `Cannot load ${role} agent file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!agent.systemPromptBody)
    throw new Error(
      `Agent file ${filePath} has an empty prompt body; refusing a role with no guidance`,
    );
  // An explicit empty list falls back to the role default so empty never
  // widens to Pi's full default toolset.
  const tools = agent.tools?.length ? agent.tools : [...defaults];
  if (role === "review") {
    const forbidden = tools.filter(
      (tool) => tool === "bash" || tool === "edit" || tool === "write",
    );
    if (forbidden.length > 0)
      throw new Error(
        `Review agent file ${filePath} requests mutating tools (${forbidden.join(", ")}); the reviewer must stay read-only`,
      );
  }
  return { agentName: agent.name, model: agent.model, tools, promptBody: agent.systemPromptBody };
}

/** Built-in configuration used when `start` is run without `--settings`. */
export function defaultLoopSettings(): LoopSettings {
  return {
    implement: {
      agentName: undefined,
      model: undefined,
      tools: [...DEFAULT_IMPLEMENT_TOOLS],
      promptBody: undefined,
    },
    review: {
      agentName: undefined,
      model: undefined,
      tools: [...DEFAULT_REVIEW_TOOLS],
      promptBody: undefined,
    },
  };
}

/**
 * Load and validate a loop settings file. All fields optional; agent paths
 * resolve relative to the settings file. Throws with a descriptive message
 * on any problem so `start` fails fast before creating a run.
 */
export function loadLoopSettings(settingsPath: string): LoopSettings {
  const resolved = resolve(settingsPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot load settings file ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`Settings file ${resolved} must contain a JSON object`);
  const config = raw as Record<string, unknown>;
  const settingsDir = dirname(resolved);
  const inline = config.appendSystemPrompt;
  if (inline !== undefined && typeof inline !== "string")
    throw new Error(`"appendSystemPrompt" in ${resolved} must be a string`);
  const appendSystemPrompt = (inline as string | undefined)?.trim() || undefined;
  return {
    implement: readAgent("implement", settingsDir, config.implementAgent),
    review: readAgent("review", settingsDir, config.reviewAgent),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
  };
}
