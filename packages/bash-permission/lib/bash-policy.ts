/**
 * bash-policy.ts — Bash permission policy engine
 *
 * Core logic for the bash permission guard extension. Provides config parsing,
 * OpenCode-compatible wildcard matching, rule merging (global + per-agent),
 * agent identity resolution, and command evaluation.
 *
 * This module is deliberately free of Pi-extension dependencies so it can be
 * tested standalone.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PermissionAction = "allow" | "ask" | "deny";

export interface BashRule {
  /** Wildcard pattern (e.g. "git *", "cat ?.txt") */
  pattern: string;
  /** Action to take when this rule matches */
  action: PermissionAction;
}

/**
 * Raw config input for a bash policy: either a blanket string or an ordered
 * object of pattern → action entries.
 */
export type BashPolicyInput = PermissionAction | Record<string, PermissionAction>;

export interface AgentPolicy {
  description?: string;
  bash: BashPolicyInput;
}

export interface BashConfig {
  version: number;
  description?: string;
  bash: BashPolicyInput;
  agents?: Record<string, AgentPolicy>;
}

export interface EvaluationResult {
  /** Final action decision */
  action: PermissionAction;
  /** The matching rule that determined the action, or null for default */
  matchedRule: BashRule | null;
  /** Resolved agent identity */
  agentIdentity: string;
}

export interface CommandEvaluation {
  /** Final action decision for this command */
  action: PermissionAction;
  /** The matching rule, or null for default */
  matchedRule: BashRule | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config parsing and validation
// ─────────────────────────────────────────────────────────────────────────────

const VALID_ACTIONS = new Set<string>(["allow", "ask", "deny"]);

/**
 * Parse and validate a raw config object.
 * Returns null if the config is malformed (fail-closed).
 */
export function parseConfig(raw: unknown): BashConfig | null {
  if (typeof raw !== "object" || raw === null) return null;

  const configRecord = raw as Record<string, unknown>;
  if (configRecord.version !== undefined && typeof configRecord.version !== "number") return null;

  const bash = parsePolicyInput(configRecord.bash);
  if (!bash) return null;

  const config: BashConfig = {
    version: typeof configRecord.version === "number" ? configRecord.version : 1,
    bash,
  };

  if (typeof configRecord.description === "string") {
    config.description = configRecord.description;
  }

  if (configRecord.agents !== undefined) {
    if (
      typeof configRecord.agents !== "object" ||
      configRecord.agents === null ||
      Array.isArray(configRecord.agents)
    )
      return null;

    const agents: Record<string, AgentPolicy> = {};
    for (const [name, agentRaw] of Object.entries(configRecord.agents)) {
      if (typeof agentRaw !== "object" || agentRaw === null || Array.isArray(agentRaw)) return null;
      const agentRecord = agentRaw as Record<string, unknown>;

      const agentBash = parsePolicyInput(agentRecord.bash);
      if (!agentBash) return null;

      const entry: AgentPolicy = { bash: agentBash };
      if (typeof agentRecord.description === "string") {
        entry.description = agentRecord.description;
      }
      agents[name] = entry;
    }
    config.agents = agents;
  }

  return config;
}

function parsePolicyInput(raw: unknown): BashPolicyInput | null {
  if (typeof raw === "string" && VALID_ACTIONS.has(raw)) {
    return raw as PermissionAction;
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rules: Record<string, PermissionAction> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (typeof val !== "string" || !VALID_ACTIONS.has(val)) {
        return null;
      }
      rules[key] = val as PermissionAction;
    }
    return rules;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a BashPolicyInput (blanket string or pattern object) into an ordered
 * list of BashRule entries. Object entries maintain insertion order (ES2015+),
 * which preserves the author's intended rule precedence.
 */
export function normalizePolicy(policy: BashPolicyInput): BashRule[] {
  if (typeof policy === "string") {
    return [{ pattern: "*", action: policy }];
  }
  return Object.entries(policy).map(([pattern, action]) => ({ pattern, action }));
}

/**
 * Merge global and per-agent rule lists.
 *
 * Global rules come first, per-agent rules after. Since the evaluator iterates
 * in order and the last matching rule wins, per-agent rules naturally override
 * global rules for the same command.
 *
 * If no agent rules exist, returns only the global list.
 */
export function mergeRules(globalRules: BashRule[], agentRules?: BashRule[]): BashRule[] {
  if (!agentRules || agentRules.length === 0) return globalRules;
  return [...globalRules, ...agentRules];
}

// ─────────────────────────────────────────────────────────────────────────────
// Wildcard matching (OpenCode-compatible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match a command string against a glob pattern with OpenCode-compatible
 * semantics:
 *
 * - `*` matches zero or more characters
 * - `?` matches exactly one character
 * - Backslashes are normalised to forward slashes
 * - If the pattern ends with ` *` (space-asterisk), the no-argument form
 *   (without the trailing ` *`) is also tried
 *
 * Returns true if the command matches the pattern.
 */
export function matchPattern(command: string, pattern: string): boolean {
  // Normalise backslashes to forward slashes
  const normalizedCommand = command.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  // Trailing " *" behaviour: also try matching the base pattern
  if (normalizedPattern.endsWith(" *")) {
    const basePattern = normalizedPattern.slice(0, -2);
    if (globMatch(normalizedCommand, basePattern)) return true;
  }

  return globMatch(normalizedCommand, normalizedPattern);
}

/**
 * Convert a glob pattern to a RegExp and test against the command.
 *
 * Escapes all regex special characters except `*` and `?`, then converts
 * `*` → `.*` and `?` → `.`.
 */
function globMatch(command: string, pattern: string): boolean {
  if (pattern === "*") return true; // fast path

  const regexStr = globToRegex(pattern);
  return new RegExp(`^${regexStr}$`).test(command);
}

/**
 * Convert a glob pattern string to a regex pattern string.
 */
function globToRegex(pattern: string): string {
  let result = "";
  for (const ch of pattern) {
    if (ch === "*") {
      result += ".*";
    } else if (ch === "?") {
      result += ".";
    } else if (isRegexSpecial(ch)) {
      result += `\\${ch}`;
    } else {
      result += ch;
    }
  }
  return result;
}

function isRegexSpecial(ch: string): boolean {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal regex character class, not a template placeholder
  return ".+^${}()|[]\\".indexOf(ch) !== -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent identity resolution
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_AGENT_RE = /<active_agent\s+name="([^"]*)"\s*\/?\s*>/g;

/**
 * Resolve the active agent identity from an `<active_agent>` tag string.
 *
 * Rules:
 * - No tag content or empty string → `"main"`
 * - No `<active_agent>` tags found and no malformed tag attempts → `"main"`
 * - Exactly one valid tag → the agent name inside `name="..."`
 * - Multiple valid tags → `null` (fail closed — ambiguous)
 * - Any syntactically malformed tag attempt → `null` (fail closed)
 * - Empty or whitespace-only name → `null` (fail closed)
 *
 * A "malformed tag attempt" is any occurrence of `<active_agent` that does
 * not match the well-formed pattern `<active_agent name="..."/>`.
 *
 * @param tagContent - Raw string that may contain `<active_agent>` tags,
 *                     or null/undefined when no tag context exists.
 * @returns Resolved agent name, or null to signal fail-closed.
 */
export function resolveAgentIdentity(tagContent: string | null | undefined): string | null {
  if (!tagContent || tagContent.trim() === "") {
    return "main";
  }

  // First, check for ANY occurrence of "<active_agent" that isn't part of
  // a well-formed tag. Any malformed tag attempt → fail closed.
  const malformedTagRe = /<active_agent(?!\s+name="[^"]*"\s*\/?\s*>)/g;
  if (malformedTagRe.test(tagContent)) {
    return null;
  }

  // Now count well-formed tags
  const matches = [...tagContent.matchAll(ACTIVE_AGENT_RE)];

  if (matches.length === 0) {
    // No tag present = treat as main session
    return "main";
  }

  if (matches.length > 1) {
    // Multiple tags — ambiguous identity, fail closed
    return null;
  }

  const name = matches[0][1].trim();
  if (!name) {
    // Tag exists but name is empty — malformed, fail closed
    return null;
  }

  return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command evaluation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ACTION: PermissionAction = "ask";

/**
 * Evaluate a single command against an ordered list of rules.
 *
 * Iterates rules in order; the last matching rule wins. If no rule matches,
 * the default action (`ask`) is returned.
 */
export function evaluateCommand(command: string, rules: BashRule[]): CommandEvaluation {
  let matchedRule: BashRule | null = null;

  for (const rule of rules) {
    if (matchPattern(command, rule.pattern)) {
      matchedRule = rule;
    }
  }

  return {
    action: matchedRule?.action ?? DEFAULT_ACTION,
    matchedRule,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full evaluation pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate a command against the full configuration for a resolved agent
 * identity.
 *
 * If `agentIdentity` is null (fail-closed from identity resolution), the
 * result is `deny` with no matched rule.
 *
 * Steps:
 * 1. Normalise global policy to rules
 * 2. Look up per-agent policy (if agent exists in config)
 * 3. Merge rules (global first, per-agent after — last match wins)
 * 4. Evaluate the command against merged rules
 */
export function evaluate(
  command: string,
  config: BashConfig,
  agentIdentity: string | null,
): EvaluationResult {
  // Fail-closed: null identity → deny
  if (agentIdentity === null) {
    return {
      action: "deny",
      matchedRule: null,
      agentIdentity: "<fail-closed>",
    };
  }

  const globalRules = normalizePolicy(config.bash);
  const agentPolicy = config.agents?.[agentIdentity];
  const agentRules = agentPolicy ? normalizePolicy(agentPolicy.bash) : undefined;
  const mergedRules = mergeRules(globalRules, agentRules);

  const { action, matchedRule } = evaluateCommand(command, mergedRules);

  return {
    action,
    matchedRule,
    agentIdentity,
  };
}
