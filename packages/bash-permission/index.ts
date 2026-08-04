/**
 * Bash Permission Extension — Enforcement Layer
 *
 * Intercepts bash tool calls via the `tool_call` event, evaluates them against
 * the permission policy, and blocks or allows them before execution.
 *
 * Uses `tool_call` rather than wrapping/registering a bash tool to avoid
 * conflicts with other extensions (e.g. pi-facelift) that also register
 * their own bash tool. This is a pure permission gate — it doesn't replace
 * the bash tool, it just gates access to it.
 *
 * - Loads policy config once at startup (fail-closed if missing/invalid).
 * - Resolves agent identity from the system prompt at tool-call time.
 * - Extracts command units from the raw bash string via tree-sitter.
 * - Evaluates each unit against the merged global + per-agent rules.
 * - If any command is denied → entire call blocked with error.
 * - If no denial but any command is "ask" → user prompted for approval.
 * - In headless mode "ask" resolves to deny.
 * - Audit entries recorded for denied/rejected/approved commands.
 */

import {
  type BashToolCallEvent,
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseConfig,
  resolveAgentIdentity,
  evaluate,
  type BashConfig,
  type BashRule,
  type PermissionAction,
  type EvaluationResult,
} from "./lib/bash-policy.js";
import { extractCommands } from "./lib/bash-extract.js";
import { HERDR_BLOCKED_EVENT } from "@pi-workspace/herdr-contract";

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

/** Parsed config cache — populated at extension load time. */
let cachedConfig: BashConfig | null = null;

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

/**
 * Load and parse the config file (bash-permission.json) from the same
 * directory as the entry point. Returns null if missing or malformed
 * (fail-closed — all commands are denied).
 */
function loadConfig(): BashConfig | null {
  try {
    const configPath = join(__dirname, "bash-permission.json");
    const raw = readFileSync(configPath, "utf-8");
    return parseConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message formatting (AC6)
// ---------------------------------------------------------------------------

interface CommandDetail {
  command: string;
  action: PermissionAction;
  matchedRule: BashRule | null;
}

/**
 * Format a human-readable summary for blocked/rejected commands.
 * Includes the raw command, agent identity, extracted units, and matched rules.
 */
function formatDecision(
  header: string,
  rawCommand: string,
  commands: string[],
  identity: string | null,
  evaluations: CommandDetail[],
): string {
  const lines: string[] = [header, ""];
  lines.push(`  Agent:  ${identity ?? "<unknown>"}`);
  lines.push("");
  lines.push(`  Raw:    ${rawCommand}`);

  // Only show extracted units when the command was split into multiple
  // pieces (e.g. chained commands, pipelines). For simple single-command
  // cases the Raw line alone is clearer.
  if (commands.length > 1) {
    lines.push("");
    for (let i = 0; i < commands.length; i++) {
      const cmdEval = evaluations[i];
      const match = cmdEval.matchedRule;
      const ruleInfo = match
        ? `"${match.pattern}" → ${match.action}`
        : "no rule matched → ask";
      lines.push(`    ${i + 1}. "${commands[i]}" → ${cmdEval.action}  (${ruleInfo})`);
    }
  }

  return lines.join("\n");
}

/**
 * Format the user-approval prompt for the "ask" case.
 */
function formatAskPrompt(
  rawCommand: string,
  commands: string[],
  identity: string | null,
  evaluations: CommandDetail[],
): string {
  return formatDecision(
    "⚠️  Bash command needs approval",
    rawCommand,
    commands,
    identity,
    evaluations,
  ) + "\n\nAllow this command?";
}

/**
 * Format the error message for denied/rejected commands.
 */
function formatDeniedMessage(
  reason: string,
  rawCommand: string,
  commands: string[],
  identity: string | null,
  evaluations: CommandDetail[],
): string {
  return formatDecision(
    `🛑 Bash command ${reason} by policy`,
    rawCommand,
    commands,
    identity,
    evaluations,
  );
}

// ---------------------------------------------------------------------------
// Audit logging (AC7)
// ---------------------------------------------------------------------------

/**
 * Append an audit entry to the session for a permission decision.
 * Only denied, rejected, and approved-after-ask decisions are logged
 * (not every allowed command).
 */
function auditLog(
  pi: ExtensionAPI,
  type: "denied" | "rejected" | "approved" | "denied-headless",
  paramsCommand: string,
  extractedCommands: string[],
  agentIdentity: string | null,
  evaluations: CommandDetail[],
): void {
  pi.appendEntry("bash-permission-audit", {
    type,
    command: paramsCommand,
    extractedCommands,
    agentIdentity: agentIdentity ?? "<fail-closed>",
    evaluations: evaluations.map((cmdEval) => ({
      command: cmdEval.command,
      action: cmdEval.action,
      matchedPattern: cmdEval.matchedRule?.pattern ?? null,
    })),
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Decision helpers
// ---------------------------------------------------------------------------

/**
 * Determine the overall action from per-command evaluations.
 *
 * - Any deny → deny overall.
 * - No deny, but any ask → ask overall.
 * - All allow → allow overall.
 */
function overallAction(evaluations: CommandDetail[]): PermissionAction {
  if (evaluations.some((cmdEval) => cmdEval.action === "deny")) return "deny";
  if (evaluations.some((cmdEval) => cmdEval.action === "ask")) return "ask";
  return "allow";
}

// ---------------------------------------------------------------------------
// Tool-call decision type
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a bash tool call.
 * - `{ block: true, reason }` — deny the call.
 * - `undefined` — allow the call to proceed normally.
 */
type BashDecision = { block: true; reason: string } | undefined;

// ---------------------------------------------------------------------------
// Permission gate — evaluate a single bash tool call
// ---------------------------------------------------------------------------

/**
 * Evaluate a bash tool call against the permission policy and return
 * a blocking decision or undefined (allow).
 */
async function evaluateBashPermission(
  pi: ExtensionAPI,
  event: BashToolCallEvent,
  ctx: ExtensionContext,
): Promise<BashDecision> {
  const command = event.input.command;
  const config = cachedConfig;

  // Step 1: Config check — fail-closed
  if (!config) {
    return {
      block: true,
      reason: "🛑 Bash command denied: permission config is missing or invalid.\nCheck bash-permission.json and reload.",
    };
  }

  // Step 2: Extract command units
  const { commands, error } = extractCommands(command);

  if (error) {
    return {
      block: true,
      reason: `🛑 Bash command denied: failed to parse command.\n\nError: ${error}`,
    };
  }

  const identity = resolveAgentIdentity(ctx.getSystemPrompt());

  // No extractable commands — fail-closed unless input is truly empty
  if (commands.length === 0) {
    const trimmed = command.trim();
    if (trimmed.length > 0) {
      return {
        block: true,
        reason: "🛑 Bash command denied: no extractable command units found.\nIf this is valid syntax, check the command and try again.",
      };
    }
    // Truly empty or whitespace-only — let through
    return;
  }

  // Step 3: Evaluate each command unit
  const evaluations: CommandDetail[] = commands.map((cmd) => {
    const result: EvaluationResult = evaluate(cmd, config, identity);
    return {
      command: cmd,
      action: result.action,
      matchedRule: result.matchedRule,
    };
  });

  // Step 4: Determine overall action
  const action = overallAction(evaluations);

  // Step 5: Deny
  if (action === "deny") {
    auditLog(pi, "denied", command, commands, identity, evaluations);
    return {
      block: true,
      reason: formatDeniedMessage("denied", command, commands, identity, evaluations),
    };
  }

  // Step 6: Ask — prompt user (or deny headless)
  if (action === "ask") {
    if (!ctx.hasUI) {
      auditLog(pi, "denied-headless", command, commands, identity, evaluations);
      return {
        block: true,
        reason: formatDeniedMessage(
          "needs approval (no UI available)",
          command,
          commands,
          identity,
          evaluations,
        ),
      };
    }

    // Notify user that permission is needed
    ctx.ui.notify("Bash permission needed", "warning");
    ctx.ui.setStatus("bash-permission", "⚠️ Waiting for approval");
    pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: "Bash permission: waiting" });
    process.stderr.write("\x07");

    const prompt = formatAskPrompt(command, commands, identity, evaluations);
    let approved: boolean;
    try {
      approved = await ctx.ui.confirm("Bash Permission", prompt);
    } catch {
      approved = false;
    }

    // Clear notification state regardless of outcome
    ctx.ui.setStatus("bash-permission", undefined);
    pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });

    if (!approved) {
      auditLog(pi, "rejected", command, commands, identity, evaluations);
      return {
        block: true,
        reason: formatDeniedMessage("rejected", command, commands, identity, evaluations),
      };
    }

    // Approved after ask
    auditLog(pi, "approved", command, commands, identity, evaluations);
  }

  // Step 7: Allow — don't block, let the tool execute normally
  return;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  cachedConfig = loadConfig();

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    return evaluateBashPermission(pi, event, ctx);
  });
}
