/**
 * settings.ts — Optional `--settings` role configuration for the issue loop.
 *
 * A settings file is a JSON object whose agent fields reference agent-format
 * markdown files (YAML frontmatter `model`/`tools` plus a prompt body).
 */
import { cpSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  /** Curated loop-skill short names; `[]` means the worker gets `--no-skills` only. */
  skills: string[];
  /** Role guidance from the active agent file (blessed default or user-supplied). `undefined` only in snapshots predating blessed defaults. */
  promptBody?: string;
}

/** Resolved settings snapshot stored with the run; `resume` reuses it verbatim. */
export interface LoopSettings {
  implement: RoleSettings;
  review: RoleSettings;
  appendSystemPrompt?: string;
}

function readAgent(role: string, settingsDir: string, ref: unknown): Omit<RoleSettings, "skills"> {
  const defaults = role === "review" ? DEFAULT_REVIEW_TOOLS : DEFAULT_IMPLEMENT_TOOLS;
  if (ref === undefined) {
    // No user file: the blessed role file is always the base, never the
    // runner's bare fallback text. It doubles as the template for
    // user-authored replacements.
    const blessed = blessedAgentsDir();
    return readAgent(
      role,
      blessed,
      role === "review" ? "./loop-reviewer.md" : "./loop-implement.md",
    );
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

/**
 * Validate one skill short-name against Pi's skill-name constraints
 * (`dist/core/skills.js` `validateName`): 1-64 chars of lowercase
 * alphanumerics and hyphens, no leading/trailing hyphen, no `--`.
 */
function assertSkillName(field: string, settingsPath: string, name: string): void {
  if (
    name.length === 0 ||
    name.length > 64 ||
    !/^[a-z0-9-]+$/.test(name) ||
    name.startsWith("-") ||
    name.endsWith("-") ||
    name.includes("--")
  )
    throw new Error(
      `"${field}" in ${settingsPath} names an invalid skill ${JSON.stringify(name)}: use 1-64 lowercase alphanumerics or hyphens, with no leading, trailing, or consecutive hyphens`,
    );
}

/** Parse and validate a per-role skill list (`implementSkills` / `reviewSkills`). Absent means the blessed default (trio for implement, empty for review); explicit `[]` opts out. */
function readSkills(role: string, field: string, settingsPath: string, value: unknown): string[] {
  if (value === undefined) return role === "implement" ? [...DEFAULT_IMPLEMENT_SKILLS] : [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`"${field}" in ${settingsPath} must be an array of skill-name strings`);
  for (const name of value) assertSkillName(field, settingsPath, name);
  const duplicates = value.filter((item, index) => value.indexOf(item) !== index);
  if (duplicates.length > 0)
    throw new Error(`"${field}" in ${settingsPath} lists ${JSON.stringify(duplicates[0])} twice`);
  return [...value];
}

/** Directory holding the blessed role agent files, resolved beside this module. */
export function blessedAgentsDir(): string {
  return resolve(import.meta.dirname, "agents");
}

/** Default implementer skill set: the curated trio every default run gets. */
export const DEFAULT_IMPLEMENT_SKILLS = ["tdd", "diagnosing-bugs", "deslop"];

/**
 * Built-in configuration used when `start` is run without `--settings`.
 * The blessed `.md` role files are always the base: a settings file replaces
 * one role's file (and skills) or the other, but a worker never runs on the
 * runner's bare fallback text. The `.md` files double as the template for
 * user-authored replacements.
 */
export function defaultLoopSettings(): LoopSettings {
  // Same shape as a `{}` settings file: blessed files with blessed skills.
  const blessed = blessedAgentsDir();
  const implement = readAgent("implement", blessed, undefined);
  const review = readAgent("review", blessed, undefined);
  return {
    implement: { ...implement, skills: [...DEFAULT_IMPLEMENT_SKILLS] },
    review: { ...review, skills: [] },
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
  const implement = readAgent("implement", settingsDir, config.implementAgent);
  const review = readAgent("review", settingsDir, config.reviewAgent);
  return {
    implement: {
      ...implement,
      skills: readSkills("implement", "implementSkills", resolved, config.implementSkills),
    },
    review: {
      ...review,
      skills: readSkills("review", "reviewSkills", resolved, config.reviewSkills),
    },
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
  };
}

/** Directory holding the curated loop skills, resolved beside this module. */
export function curatedSkillsDir(): string {
  return resolve(import.meta.dirname, "loop-skills");
}

/** Fail fast when a selected skill has no `<curatedDir>/<name>/SKILL.md`. */
export function validateLoopSkills(
  settings: LoopSettings,
  curatedDir: string = curatedSkillsDir(),
): void {
  const names = new Set([...settings.implement.skills, ...settings.review.skills]);
  for (const name of names) {
    const marker = join(resolve(curatedDir), name, "SKILL.md");
    try {
      statSync(marker);
    } catch {
      throw new Error(
        `Unknown loop skill ${JSON.stringify(name)}: no ${marker}; available skills live in ${resolve(curatedDir)}`,
      );
    }
  }
}

/**
 * Copy the selected skills into `<runDir>/skills/<name>/`. Call once at
 * `start`; `resume` reuses the copy so a run never drifts with the curated dir.
 */
export function materializeLoopSkills(
  settings: LoopSettings,
  runDir: string,
  curatedDir: string = curatedSkillsDir(),
): void {
  validateLoopSkills(settings, curatedDir);
  const names = new Set([...settings.implement.skills, ...settings.review.skills]);
  for (const name of names)
    cpSync(join(resolve(curatedDir), name), join(runDir, "skills", name), { recursive: true });
  if (names.size === 0) mkdirSync(join(runDir, "skills"), { recursive: true });
}
