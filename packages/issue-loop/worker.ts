import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { tailText } from "./process.ts";

/**
 * Supervised worker module: launches the installed Pi executable in RPC mode,
 * frames its LF-delimited JSONL stream, correlates command responses, and
 * returns the authoritative completed outcome for one phase task.
 *
 * Transport helpers stay private; callers hand over a phase task and receive a
 * validated phase outcome.
 */

export type WorkerPhase = "editing" | "review";

export type EditingOutcomeName = "complete" | "incomplete" | "blocked";
export type ReviewOutcomeName = "pass" | "changes_requested" | "incomplete" | "blocked";
export type PhaseOutcomeName = EditingOutcomeName | ReviewOutcomeName;

export type Severity = "critical" | "major" | "minor";
export type FindingAxis = "spec" | "standards";

export interface ParsedFinding {
  axis: FindingAxis;
  severity: Severity;
  location: string;
  description: string;
}

export interface PhaseOutcome {
  outcome: PhaseOutcomeName;
  summary: string;
  findings: ParsedFinding[];
  remainingWork?: string;
  blockers?: string;
}

export interface WorkerOptions {
  /** Pi CLI arguments, excluding the prompt, which is sent over RPC. */
  args: string[];
  cwd: string;
  prompt: string;
  log: string;
  /** Hard ceiling for this phase task. Watchdog policy is layered on in later slices. */
  timeoutMs: number;
  /** Grace after a settled process closes stdin before SIGTERM. Defaults to 2000 ms. */
  settleGraceMs?: number;
  /** SIGTERM-to-SIGKILL escalation once shutdown begins. Defaults to 2000 ms. */
  sigkillEscalationMs?: number;
  /** Defaults to `pi`; tests inject a fake peer. */
  executable?: string;
}

const PROMPT_ID = "loop-prompt";
const EDITING_OUTCOMES: PhaseOutcomeName[] = ["complete", "incomplete", "blocked"];
const REVIEW_OUTCOMES: PhaseOutcomeName[] = ["pass", "changes_requested", "incomplete", "blocked"];
const SEVERITIES: Severity[] = ["critical", "major", "minor"];
const FINDING_AXES: FindingAxis[] = ["spec", "standards"];
const TOP_LEVEL_KEYS = ["blockers", "findings", "outcome", "remainingWork", "summary"];
const FINDING_KEYS = ["axis", "description", "location", "severity"];

/**
 * Canonical examples advertised in the worker prompt. Tests feed these exact
 * shapes through `parsePhaseOutcome`, so the prompt cannot drift from the
 * validator that rejects invalid phase/outcome combinations.
 */
export const EDITING_OUTCOME_EXAMPLES: readonly {
  outcome: EditingOutcomeName;
  example: Record<string, unknown>;
}[] = [
  { outcome: "complete", example: { outcome: "complete", summary: "What changed and why." } },
  {
    outcome: "incomplete",
    example: {
      outcome: "incomplete",
      summary: "What is done so far.",
      remainingWork: "What is still to do.",
    },
  },
  {
    outcome: "blocked",
    example: {
      outcome: "blocked",
      summary: "What you attempted.",
      blockers: "What stops further progress.",
    },
  },
];

export const REVIEW_OUTCOME_EXAMPLES: readonly {
  outcome: ReviewOutcomeName;
  example: Record<string, unknown>;
}[] = [
  {
    outcome: "pass",
    example: {
      outcome: "pass",
      summary: "No critical or major problems.",
      findings: [
        {
          axis: "standards",
          severity: "minor",
          location: "path/to/file.ts:12",
          description: "Optional cleanup.",
        },
      ],
    },
  },
  {
    outcome: "changes_requested",
    example: {
      outcome: "changes_requested",
      summary: "What must change before acceptance.",
      findings: [
        {
          axis: "spec",
          severity: "major",
          location: "path/to/file.ts:12",
          description: "Unmet acceptance criterion.",
        },
      ],
    },
  },
  {
    outcome: "incomplete",
    example: {
      outcome: "incomplete",
      summary: "What was assessed so far.",
      findings: [],
      remainingWork: "What is still to assess.",
    },
  },
  {
    outcome: "blocked",
    example: {
      outcome: "blocked",
      summary: "What you attempted.",
      findings: [],
      blockers: "What stops the assessment.",
    },
  },
];

/** Split an LF-delimited stream without treating Unicode separators as boundaries. */
class LineFramer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    for (let index = this.buffer.indexOf("\n"); index !== -1; index = this.buffer.indexOf("\n")) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length) lines.push(line);
    }
    return lines;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant") return undefined;
  return textFromContent(record.content);
}

export interface WorkerRunResult {
  /** Authoritative final assistant text from the settled run. */
  text: string;
}

/**
 * Launch Pi in RPC mode and wait for the session-level run to settle. Prompt
 * acceptance and intermediate `agent_end` events do not complete the task.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerRunResult> {
  const program = options.executable ?? "pi";
  if (options.log) writeFileSync(options.log, "", { mode: 0o600 });
  return new Promise<WorkerRunResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const child = spawn(program, options.args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let finished = false;
    let failure: string | undefined;
    let accepted = false;
    let settled = false;
    let assistant = "";
    let stderr = "";
    let terminal: { stopReason?: string; errorMessage?: string } | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve({ text: assistant });
    };
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
    };
    const interrupt = () => {
      if (failure) killGroup("SIGKILL");
      else stop("Interrupted; work has been preserved");
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    timeoutTimer = setTimeout(() => stop(`Timed out running ${program}`), options.timeoutMs);

    const handleRecord = (record: unknown) => {
      if (!record || typeof record !== "object") return;
      const value = record as Record<string, unknown>;
      if (value.type === "response") {
        if (value.command !== "prompt" || value.id !== PROMPT_ID) return;
        if (value.success !== true) {
          stop(`pi rejected the prompt: ${String(value.error ?? "unknown error")}`);
          return;
        }
        const disposition = (value.data as { disposition?: unknown } | undefined)?.disposition;
        if (disposition === "handled") {
          stop("pi handled the prompt without starting a run");
          return;
        }
        if (disposition !== "started" && disposition !== "queued") {
          stop(`pi returned an unknown prompt disposition ${JSON.stringify(disposition)}`);
          return;
        }
        accepted = true;
        return;
      }
      if (value.type === "message_end") {
        const message = value.message;
        if (message && typeof message === "object") {
          const record = message as {
            role?: unknown;
            stopReason?: unknown;
            errorMessage?: unknown;
          };
          if (record.role === "assistant") {
            terminal = {
              stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
              errorMessage:
                typeof record.errorMessage === "string" ? record.errorMessage : undefined,
            };
          }
        }
        const text = assistantText(message);
        if (text !== undefined) assistant = text;
        return;
      }
      if (value.type === "agent_settled") {
        if (!accepted) {
          stop("pi settled before accepting the prompt");
          return;
        }
        // Pi settles failed and aborted responses too. Only a successful final
        // message is authoritative, so valid outcome JSON inside a failed
        // stream cannot approve work.
        if (terminal?.stopReason === "error" || terminal?.stopReason === "aborted") {
          stop(
            `pi settled after an unsuccessful response (${terminal.stopReason}${
              terminal.errorMessage ? `: ${terminal.errorMessage}` : ""
            })`,
          );
          return;
        }
        if (terminal?.errorMessage) {
          stop(`pi settled after reporting an error: ${terminal.errorMessage}`);
          return;
        }
        settled = true;
        clearTimeout(timeoutTimer);
        try {
          child.stdin.end();
        } catch {
          /* Child already closed its stdin. */
        }
        // Give the process a bounded chance to exit, then escalate SIGTERM to
        // SIGKILL so an uncooperative peer cannot hold the run lock after the
        // run has settled.
        drainTimer = setTimeout(() => {
          killGroup("SIGTERM");
          killTimer = setTimeout(() => killGroup("SIGKILL"), options.sigkillEscalationMs ?? 2_000);
        }, options.settleGraceMs ?? 2_000);
        drainTimer.unref?.();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const framer = new LineFramer();
    child.stdout.on("data", (data: string) => {
      if (options.log) appendFileSync(options.log, data);
      for (const line of framer.push(data)) {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          stop(`pi emitted malformed JSON: ${line.slice(0, 200)}`);
          continue;
        }
        handleRecord(record);
      }
    });
    child.stderr.on("data", (data: string) => {
      if (options.log) appendFileSync(options.log, data);
      stderr += data;
    });
    child.stdin.on("error", () => {
      /* The child can exit before consuming its prompt. */
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (failure)
        finish(
          new Error(
            `${failure}\n${tailText(stderr, 4000)}${options.log ? `\nLog: ${options.log}` : ""}`,
          ),
        );
      else if (settled) finish();
      else {
        const reason = signal ? `${program} terminated by ${signal}` : `${program} exited ${code}`;
        finish(
          new Error(
            `${reason} before the run settled\n${tailText(stderr, 4000)}${options.log ? `\nLog: ${options.log}` : ""}`,
          ),
        );
      }
    });
    child.stdin.write(
      `${JSON.stringify({ id: PROMPT_ID, type: "prompt", message: options.prompt })}\n`,
    );
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reject any top-level key the phase contract does not define. */
function assertKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.includes(key)) throw new Error(`unexpected key ${JSON.stringify(key)}`);
  }
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${key} must be a non-empty string`);
  return raw.trim();
}

function parseFindings(value: unknown): ParsedFinding[] {
  if (!Array.isArray(value)) throw new Error("findings must be an array");
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw new Error("each finding must be an object");
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== FINDING_KEYS.join(","))
      throw new Error(`each finding must have exactly ${FINDING_KEYS.join(", ")}`);
    const severity = entry.severity;
    if (typeof severity !== "string" || !SEVERITIES.includes(severity as Severity))
      throw new Error(`finding severity must be one of ${SEVERITIES.join(", ")}`);
    const axis = entry.axis;
    if (typeof axis !== "string" || !FINDING_AXES.includes(axis as FindingAxis))
      throw new Error(`finding axis must be one of ${FINDING_AXES.join(", ")}`);
    return {
      axis: axis as FindingAxis,
      severity: severity as Severity,
      location: readRequiredString(entry, "location"),
      description: readRequiredString(entry, "description"),
    };
  });
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* Fall through to fence and object extraction. */
  }
  let candidate = trimmed;
  // Only strip a fence that wraps the whole reply; backticks inside JSON strings are content.
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Validate a phase-specific structured outcome. Editing permits complete;
 * review permits pass/changes_requested; both permit incomplete/blocked.
 * Material critical/major findings are inconsistent with a pass.
 */
export function parsePhaseOutcome(phase: WorkerPhase, text: string): PhaseOutcome {
  let raw: unknown;
  try {
    raw = extractJsonObject(text);
  } catch (error) {
    throw new Error(
      `Invalid ${phase} outcome: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(raw)) throw new Error(`Invalid ${phase} outcome: expected a JSON object`);
  try {
    assertKeys(raw);
    const outcome = raw.outcome;
    const allowed = phase === "editing" ? EDITING_OUTCOMES : REVIEW_OUTCOMES;
    if (typeof outcome !== "string" || !allowed.includes(outcome as PhaseOutcomeName))
      throw new Error(
        `outcome must be one of ${allowed.join(", ")} during ${phase} (got ${JSON.stringify(outcome)})`,
      );
    const summary = readRequiredString(raw, "summary");
    const findings = phase === "review" ? parseFindings(raw.findings) : [];
    if (phase === "editing" && raw.findings !== undefined) {
      if (!Array.isArray(raw.findings)) throw new Error("findings must be an array");
      if (raw.findings.length) throw new Error("editing outcomes cannot carry findings");
    }
    const result: PhaseOutcome = { outcome: outcome as PhaseOutcomeName, summary, findings };
    const remainingWork = raw.remainingWork;
    if (remainingWork !== undefined && (typeof remainingWork !== "string" || !remainingWork.trim()))
      throw new Error("remainingWork must be a non-empty string when present");
    const blockers = raw.blockers;
    if (blockers !== undefined && (typeof blockers !== "string" || !blockers.trim()))
      throw new Error("blockers must be a non-empty string when present");
    if (outcome === "incomplete") {
      if (typeof remainingWork !== "string" || !remainingWork.trim())
        throw new Error("incomplete outcomes must report remainingWork");
      result.remainingWork = remainingWork.trim();
    } else if (typeof remainingWork === "string" && remainingWork.trim()) {
      throw new Error(`${outcome} outcomes cannot report remainingWork`);
    }
    if (outcome === "blocked") {
      if (typeof blockers !== "string" || !blockers.trim())
        throw new Error("blocked outcomes must report blockers");
      result.blockers = blockers.trim();
    } else if (typeof blockers === "string" && blockers.trim()) {
      throw new Error(`${outcome} outcomes cannot report blockers`);
    }
    if (phase === "review") {
      const material = findings.some(
        (finding) => finding.severity === "critical" || finding.severity === "major",
      );
      if (outcome === "pass" && material)
        throw new Error("a pass cannot carry critical or major findings");
      if (outcome === "changes_requested" && !material)
        throw new Error("changes_requested must carry at least one critical or major finding");
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserve an already-qualified message so callers get one clear reason.
    if (message.startsWith(`Invalid ${phase} outcome:`)) throw error;
    throw new Error(`Invalid ${phase} outcome: ${message}`);
  }
}
