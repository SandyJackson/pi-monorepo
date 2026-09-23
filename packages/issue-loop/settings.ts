/**
 * settings.ts — Optional `--settings` role configuration for the issue loop.
 *
 * A settings file is a JSON object whose agent fields reference agent-format
 * markdown files (YAML frontmatter `model`/`tools` plus a prompt body), parsed
 * with the shared loader from `@pi-workspace/herdr-subagent/agents`. See the
 * cross-package contract note on `ParsedAgentFile` there before changing how
 * agent files are interpreted here.
 *
 * Divergences from subagent discovery, by design:
 * - Agent files need no `description`; the loop never lists them.
 * - An absent `tools` field keeps the loop's per-role restrictions below
 *   (never Pi's full default toolset), so omitting `tools` from a review
 *   agent cannot silently widen the read-only reviewer.
 * - `extensions:` and `skills:` frontmatter keys are parsed but ignored by
 *   the loop. Skill/extension support is a documented future iteration.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadAgentFile, type ParsedAgentFile } from "@pi-workspace/herdr-subagent/agents";

/** Tool allowlist used when the implement agent file omits `tools`. */
export const DEFAULT_IMPLEMENT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/** Tool allowlist used when the review agent file omits `tools`. */
export const DEFAULT_REVIEW_TOOLS = ["read", "grep", "find", "ls"];

/** Tools a review agent may never request; the reviewer stays read-only. */
const REVIEW_FORBIDDEN_TOOLS = new Set(["bash", "edit", "write"]);

const SETTINGS_KEYS = new Set([
  "implementAgent",
  "reviewAgent",
  "appendSystemPrompt",
  "appendSystemPromptFile",
]);

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
    agent = loadAgentFile(filePath);
  } catch (error) {
    throw new Error(
      `Cannot load ${role} agent file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!agent.systemPromptBody)
    throw new Error(
      `Agent file ${filePath} has an empty prompt body; refusing a role with no guidance`,
    );
  const tools = agent.tools ?? [...defaults];
  if (role === "review") {
    const forbidden = tools.filter((tool) => REVIEW_FORBIDDEN_TOOLS.has(tool));
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
  for (const key of Object.keys(config)) {
    if (!SETTINGS_KEYS.has(key))
      throw new Error(
        `Unknown settings key "${key}" in ${resolved}; expected ${[...SETTINGS_KEYS].join(", ")}`,
      );
  }
  const settingsDir = dirname(resolved);
  const inline = config.appendSystemPrompt;
  const fileRef = config.appendSystemPromptFile;
  if (inline !== undefined && typeof inline !== "string")
    throw new Error(`"appendSystemPrompt" in ${resolved} must be a string`);
  if (fileRef !== undefined && (typeof fileRef !== "string" || !fileRef.trim()))
    throw new Error(`"appendSystemPromptFile" in ${resolved} must be a file path`);
  if (inline !== undefined && fileRef !== undefined)
    throw new Error(
      `Settings file ${resolved} sets both "appendSystemPrompt" and "appendSystemPromptFile"; use one`,
    );
  // The shared prompt file is plain markdown: used verbatim, never frontmatter-parsed.
  const fromFile =
    fileRef === undefined ? undefined : readFileSync(resolve(settingsDir, fileRef), "utf8").trim();
  const appendSystemPrompt = (inline?.trim() || fromFile) ?? undefined;
  return {
    implement: readAgent("implement", settingsDir, config.implementAgent),
    review: readAgent("review", settingsDir, config.reviewAgent),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
  };
}
