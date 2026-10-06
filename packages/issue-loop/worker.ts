import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { tailText } from "./process.ts";
import { DEFAULT_WATCHDOG, type WatchdogSettings } from "./settings.ts";

/**
 * Supervised worker module: launches the installed Pi executable in RPC mode,
 * frames its LF-delimited JSONL stream, correlates command responses, tracks
 * model/tool progress, and applies the phase watchdog (checkpoint, one
 * continuation, bounded abort/termination) before returning the authoritative
 * completed outcome for one phase task.
 *
 * Transport helpers stay private; callers hand over a phase task, the durable
 * recovery context, and receive a validated phase outcome.
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

/** Injectable time source so tests can advance watchdog deadlines virtually. */
export interface WorkerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: WorkerClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Structured checkpoint evidence persisted by the controller before recovery. */
export interface CheckpointEvidence {
  reason: string;
  detail: string;
  elapsedMs: number;
  consumedMs: number;
}

/** Durable per-phase-task allowance and stop context consumed by earlier attempts. */
export interface WorkerRecovery {
  /** Execution time already consumed by this phase task. */
  consumedMs?: number;
  /** Whether the one incomplete/stalled continuation has been used. */
  continuationUsed?: boolean;
  /** Controller transient retries already consumed by this phase task. */
  transientRetries?: number;
  /** Response correction attempts already consumed by this phase task. */
  corrections?: number;
  /** Why the interrupted attempt stopped, replayed as recovery context. */
  stopReason?: string;
  /** Checkpoint requested before the attempt stopped, replayed on recovery. */
  checkpoint?: CheckpointEvidence;
}

/** Periodic runtime accounting so a controller crash cannot replenish an allowance. */
export interface WorkerAccounting {
  consumedMs: number;
  continuationUsed: boolean;
  transientRetries: number;
  corrections: number;
}

/** Watchdog decision recorded before the controller acts on it. */
export interface WorkerIntervention {
  kind: "checkpoint" | "continuation" | "abort" | "retry" | "correction";
  phase: WorkerPhase;
  reason: string;
  detail: string;
  elapsedMs: number;
  consumedMs: number;
  continuationUsed: boolean;
  transientRetries: number;
  corrections: number;
  queuedSteering?: string[];
  queuedFollowUp?: string[];
}

export interface WorkerOptions {
  /** Pi CLI arguments, excluding the prompt, which is sent over RPC. */
  args: string[];
  cwd: string;
  prompt: string;
  log: string;
  /** Phase the worker is performing; drives the checkpoint contract. */
  phase?: WorkerPhase;
  /** Hard ceiling override when `watchdog.hardCeilingMs` is not supplied. */
  timeoutMs?: number;
  /** Progress-watchdog policy. Missing fields fall back to `DEFAULT_WATCHDOG`. */
  watchdog?: WatchdogSettings;
  /** Time source for watchdog/termination deadlines; defaults to wall time. */
  clock?: WorkerClock;
  /** Allowance already consumed by this phase task. */
  recovery?: WorkerRecovery;
  /**
   * Validate a settled response. A thrown error requests one correction prompt
   * in the same session before the phase task is allowed to fail.
   */
  resolveOutcome?: (text: string) => PhaseOutcome;
  /** Maximum classified transient controller retries. Defaults to 0. */
  transientRetryLimit?: number;
  /** Backoff before each transient retry; index i is used for retry i+1. */
  transientBackoffMs?: number[];
  /** Called before a checkpoint, continuation, or abort is acted on. */
  onIntervention?: (notice: WorkerIntervention) => void;
  /** Called periodically so the controller can persist runtime across a crash. */
  onAccounting?: (accounting: WorkerAccounting) => void;
  /** Grace after a settled process closes stdin before SIGTERM. Defaults to 2000 ms. */
  settleGraceMs?: number;
  /** SIGTERM-to-SIGKILL escalation once shutdown begins. */
  sigkillEscalationMs?: number;
  /** Defaults to `pi`; tests inject a fake peer. */
  executable?: string;
}

const INITIAL_PROMPT_ID = "prompt-1";
const CHECKPOINT_STEER_ID = "steer-1";
const CLEAR_QUEUE_ID = "clear-1";
const ABORT_ID = "abort-1";

/**
 * Provider failures Pi itself treats as non-retryable. Pi does not expose the
 * retryability flag over RPC, and `auto_retry_end(success: false)` is emitted
 * for exhausted retries, a cancelled retry, and a non-retryable error after an
 * earlier retry alike. Re-classify the recorded error so only a known transient
 * failure spends a controller retry. Mirrors Pi's `isRetryableAssistantError`
 * (`agent-session.ts` / `buildProviderErrorPattern`).
 */
const NON_RETRYABLE_PROVIDER_ERROR_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/i;
const RETRYABLE_PROVIDER_ERROR_PATTERN =
  /overloaded|currently experiencing high demand|rate.?limit|too many requests|429|500|502|503|504|520|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|exceeded request buffer limit while retrying upstream|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted|subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable/i;

/**
 * Classify a recorded final failure. Cancellation, provider limits (billing,
 * quota) and unrecognized errors are never retried; only known transient
 * provider failures are.
 */
function isTransientProviderFailure(finalError: string | undefined): boolean {
  if (!finalError) return false;
  if (/retry cancelled/i.test(finalError)) return false;
  if (NON_RETRYABLE_PROVIDER_ERROR_PATTERN.test(finalError)) return false;
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(finalError);
}

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

/**
 * Signature for a partial tool result. Bash (and similar tools) stream an
 * accumulated snapshot, so callers must compare whole snapshots rather than
 * treating each update as a delta. Empty and duplicate snapshots are not new
 * progress.
 */
function snapshotSignature(partialResult: unknown): string {
  if (!partialResult || typeof partialResult !== "object") return "";
  const record = partialResult as { content?: unknown };
  // Content-bearing tools (bash and friends) stream accumulated text snapshots.
  // An absent content field falls back to a structural signature; an empty
  // content snapshot is not progress.
  if (record.content !== undefined) return textFromContent(record.content);
  try {
    return JSON.stringify(partialResult) ?? "";
  } catch {
    return "";
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h${minutes}m${seconds}s`;
  if (minutes) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** Structured handoff requested when a phase stalls or runs long. */
function checkpointPrompt(
  phase: WorkerPhase,
  step: string,
  elapsedMs: number,
  lastProgress: string,
): string {
  const allowed =
    phase === "review"
      ? "pass, changes_requested, incomplete, or blocked"
      : "complete, incomplete, or blocked";
  return [
    "Controller checkpoint: this phase needs a structured handoff now.",
    `Phase: ${phase}`,
    `Step: ${step}`,
    `Elapsed: ${formatDuration(elapsedMs)}`,
    `Last progress: ${lastProgress}`,
    "",
    "Finish the current bounded operation, stop making further changes, and reply with exactly one structured outcome JSON object (the same schema as the phase task).",
    `Allowed outcomes: ${allowed}. Use incomplete with remainingWork when the work is not finished, or blocked with blockers when you cannot proceed.`,
    "Briefly explain why this step has taken so long so the controller can avoid repeating it blindly.",
  ].join("\n");
}

/** Same-session continuation prompt after an incomplete checkpoint. */
function continuationPrompt(
  phase: WorkerPhase,
  checkpointSummary: string,
  remainingWork: string,
): string {
  return [
    "The controller granted one same-session continuation within the remaining phase allowance.",
    checkpointSummary ? `Checkpoint record: ${checkpointSummary}` : "",
    remainingWork ? `Remaining work reported: ${remainingWork}` : "",
    "Resume the phase from where you stopped. Inspect any command that stalled before repeating it; do not repeat it blindly.",
    `When finished, reply with exactly one structured ${phase} outcome JSON object.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Same-session retry prompt used after Pi's own native retries are exhausted.
 * Replays the recorded failure so the agent can avoid repeating it blindly.
 */
function transientRetryPrompt(phase: WorkerPhase, failure: string): string {
  return [
    "Pi exhausted its native provider retries and the previous attempt failed transiently.",
    `Recorded failure: ${failure}`,
    "The controller is retrying this phase within its bounded transient budget. Continue from where it stopped.",
    "Inspect any step or command involved in the failure before repeating it; do not repeat a failed or stalled command blindly.",
    `When finished, reply with exactly one structured ${phase} outcome JSON object.`,
  ].join("\n");
}

/** One correction prompt for a malformed or phase-inconsistent response. */
function correctionPrompt(phase: WorkerPhase, problem: string): string {
  const allowed =
    phase === "review"
      ? "pass, changes_requested, incomplete, or blocked"
      : "complete, incomplete, or blocked";
  return [
    "The controller could not accept your previous reply as a valid phase outcome.",
    `Problem: ${problem}`,
    "Reply again with exactly one structured outcome JSON object and no trailing text.",
    `Allowed outcomes: ${allowed}. Use incomplete with remainingWork when the work is not finished, or blocked with blockers when you cannot proceed.`,
  ].join("\n");
}

/**
 * Replay the interrupted attempt's stop evidence as the first prompt of a
 * resumed phase task, so an unconsumed checkpoint steer is not the only record.
 */
function recoveryPrompt(recovery: WorkerRecovery | undefined): string | undefined {
  if (!recovery) return undefined;
  const lines: string[] = [];
  if (recovery.stopReason) lines.push(`Previous attempt stopped: ${recovery.stopReason}`);
  if (recovery.checkpoint) {
    const summary = `${recovery.checkpoint.reason}: ${recovery.checkpoint.detail}`;
    if (summary !== recovery.stopReason)
      lines.push(
        `Checkpoint requested after ${formatDuration(recovery.checkpoint.elapsedMs)}: ${summary}`,
      );
  }
  if (!lines.length) return undefined;
  return [
    "Recovery context from the interrupted attempt. This is why the previous run stopped; inspect the failed step before repeating it blindly.",
    ...lines,
  ].join("\n");
}

/** One in-flight tool call; progress is tracked per call, not globally. */
interface TrackedTool {
  id: string;
  name: string;
  startedAt: number;
  /** Last observable output for this call; silence is per-call. */
  progressAt: number;
  signature: string;
}

export interface WorkerRunResult {
  /** Authoritative final assistant text from the settled run. */
  text: string;
  /** Validated phase outcome; present when the caller supplied `resolveOutcome`. */
  outcome?: PhaseOutcome;
  /** Execution time consumed by this phase task, including earlier attempts. */
  consumedMs: number;
  /** Whether the single incomplete/stalled continuation was used. */
  continuationUsed: boolean;
  /** Classified transient controller retries consumed. */
  transientRetries: number;
  /** Response correction attempts consumed. */
  corrections: number;
}

/**
 * Launch Pi in RPC mode and wait for the session-level run to settle. Prompt
 * acceptance and intermediate `agent_end` events do not complete the task.
 * A stall or an over-long phase is turned into a checkpoint, one continuation,
 * then a bounded abort and process-group termination.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerRunResult> {
  const program = options.executable ?? "pi";
  const clock = options.clock ?? realClock;
  const phase: WorkerPhase = options.phase ?? "editing";
  const policy = { ...DEFAULT_WATCHDOG, ...options.watchdog };
  const hardCeilingMs = Math.max(
    1,
    options.watchdog?.hardCeilingMs ?? options.timeoutMs ?? policy.hardCeilingMs,
  );
  const settleGraceMs = options.settleGraceMs ?? 2_000;
  const sigkillEscalationMs =
    options.sigkillEscalationMs ??
    options.watchdog?.sigkillEscalationMs ??
    DEFAULT_WATCHDOG.sigkillEscalationMs;
  if (options.log) writeFileSync(options.log, "", { mode: 0o600 });
  return new Promise<WorkerRunResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const child = spawn(program, options.args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const startedAt = clock.now();
    const consumedBefore = Math.max(0, options.recovery?.consumedMs ?? 0);
    const hardDeadline = startedAt + Math.max(0, hardCeilingMs - consumedBefore);
    const softCheckpointMs = policy.softCheckpointMs;
    const softDeadline = startedAt + Math.max(0, softCheckpointMs - consumedBefore);
    const silenceMs = policy.silenceMs;
    const toolMs = policy.toolMs;
    const checkpointGraceMs = policy.checkpointGraceMs;
    const abortGraceMs = policy.abortGraceMs;

    let finished = false;
    let failure: string | undefined;
    let accepted = false;
    let settled = false;
    let assistant = "";
    let stderr = "";
    let terminal: { stopReason?: string; errorMessage?: string } | undefined;
    let resolvedOutcome: PhaseOutcome | undefined;

    let watchdogTimer: unknown;
    let abortTimer: unknown;
    let killTimer: unknown;
    let drainTimer: unknown;
    let accountingTimer: unknown;
    let retryTimer: unknown;

    // Model generation and each in-flight tool call track progress separately,
    // so activity in one call cannot hide another that has gone silent.
    let modelProgressAt = startedAt;
    let lastProgress = "phase started";
    const tools = new Map<string, TrackedTool>();

    let softCheckpointUsed = consumedBefore >= softCheckpointMs;
    let continuationUsed = options.recovery?.continuationUsed ?? false;
    // Recovery counters are separate and durable: native retries stay outside
    // the controller budget, and a restart never replenishes them.
    let transientRetries = Math.max(0, options.recovery?.transientRetries ?? 0);
    let corrections = Math.max(0, options.recovery?.corrections ?? 0);
    const transientRetryLimit = Math.max(0, options.transientRetryLimit ?? 0);
    const transientBackoffMs = options.transientBackoffMs ?? [];
    let autoRetryExhausted = false;
    let autoRetryFinalError: string | undefined;
    // A native-retry exhaustion belongs to the assistant failure that produced
    // it. Pi may process queued steering in a later turn before settling; a
    // fresh failure must not reuse the earlier transient classification.
    let assistantFailures = 0;
    let autoRetryFailure = -1;
    let retryScheduled = false;
    let promptSequence = 1;
    let activePromptId = INITIAL_PROMPT_ID;
    let awaitingCheckpoint = false;
    let checkpointDeadline = 0;
    const checkpointReasons: string[] = [];

    let aborted = false;
    let abortReason: string | undefined;
    let abortAcknowledged = false;
    let terminated = false;
    let queuedSteering: string[] = [];
    let queuedFollowUp: string[] = [];

    const consumedMs = () => consumedBefore + (clock.now() - startedAt);

    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const clearTimer = (handle: unknown) => {
      if (handle !== undefined) clock.clearTimer(handle);
    };
    const cleanup = () => {
      clearTimer(watchdogTimer);
      clearTimer(abortTimer);
      clearTimer(retryTimer);
      // A terminated process group may still hold members that ignored SIGTERM;
      // leave the bounded SIGKILL escalation running so they cannot outlive the
      // worker or keep mutating the worktree after termination.
      if (!terminated) clearTimer(killTimer);
      clearTimer(drainTimer);
      clearTimer(accountingTimer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    };
    const flushAccounting = () => {
      if (!options.onAccounting) return;
      try {
        options.onAccounting({
          consumedMs: consumedMs(),
          continuationUsed,
          transientRetries,
          corrections,
        });
      } catch (error) {
        console.error(
          `Warning: could not persist worker accounting: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const groupAlive = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    let escalationComplete = false;
    let settleAfterEscalation: (() => void) | undefined;
    const settle = (error?: Error) => {
      // Persist elapsed accounting on every exit, successful or not, so resume
      // never replenishes a partially consumed phase allowance.
      flushAccounting();
      cleanup();
      if (error) reject(error);
      else
        resolve({
          text: assistant,
          outcome: resolvedOutcome,
          consumedMs: consumedMs(),
          continuationUsed,
          transientRetries,
          corrections,
        });
    };
    const terminateProcess = () => {
      if (terminated) return;
      terminated = true;
      killGroup("SIGTERM");
      if (killTimer === undefined)
        killTimer = clock.setTimer(() => {
          killGroup("SIGKILL");
          killTimer = undefined;
          escalationComplete = true;
          const pending = settleAfterEscalation;
          settleAfterEscalation = undefined;
          pending?.();
        }, sigkillEscalationMs);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      // Complete bounded process-group cleanup before settling. A leader can
      // close before acknowledging an abort, and its descendants would
      // otherwise survive the worker promise and keep mutating the worktree.
      if (!terminated) terminateProcess();
      if (!escalationComplete) {
        if (groupAlive()) {
          settleAfterEscalation = () => settle(error);
          return;
        }
        // The group is already gone; the retained escalation is unnecessary.
        clearTimer(killTimer);
        killTimer = undefined;
        escalationComplete = true;
      }
      settle(error);
    };
    const stop = (reason: string) => {
      if (failure || abortReason) return;
      failure = reason;
      clearTimer(watchdogTimer);
      watchdogTimer = undefined;
      // A pending transient-retry backoff must not dispatch a new turn after
      // the phase has been stopped.
      clearTimer(retryTimer);
      retryTimer = undefined;
      retryScheduled = false;
      // Persist diagnostics and consumed runtime before terminating so a
      // controller interrupt does not replenish the phase allowance.
      notify("abort", "stopped", reason);
      terminateProcess();
    };
    const interrupt = () => {
      if (failure || abortReason || terminated) killGroup("SIGKILL");
      else stop("Interrupted; work has been preserved");
    };
    const closeStdin = () => {
      try {
        child.stdin.end();
      } catch {
        /* Child already closed its stdin. */
      }
    };
    const sendCommand = (command: Record<string, unknown>) => {
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch {
        /* The child exited before the command could be written. */
      }
    };
    const notify = (kind: WorkerIntervention["kind"], reason: string, detail: string) => {
      if (!options.onIntervention) return;
      try {
        options.onIntervention({
          kind,
          phase,
          reason,
          detail,
          elapsedMs: clock.now() - startedAt,
          consumedMs: consumedMs(),
          continuationUsed,
          transientRetries,
          corrections,
          ...(queuedSteering.length ? { queuedSteering: [...queuedSteering] } : {}),
          ...(queuedFollowUp.length ? { queuedFollowUp: [...queuedFollowUp] } : {}),
        });
      } catch (error) {
        stop(
          `Failed to persist worker recovery state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const longestRunningTool = () => {
      let oldest: TrackedTool | undefined;
      for (const tool of tools.values())
        if (!oldest || tool.startedAt < oldest.startedAt) oldest = tool;
      return oldest;
    };
    const stepDescription = () => {
      const tool = longestRunningTool();
      return tool
        ? `tool ${tool.name} (${tool.id}) running ${formatDuration(clock.now() - tool.startedAt)}`
        : "model generation";
    };

    const markModelProgress = (detail?: string) => {
      modelProgressAt = clock.now();
      if (detail) lastProgress = detail;
      refreshWatchdog();
    };
    const markToolProgress = (tool: TrackedTool, detail?: string) => {
      tool.progressAt = clock.now();
      if (detail) lastProgress = detail;
      refreshWatchdog();
    };

    // Earliest due violation, so a stalled tool is reported even while another
    // call keeps producing output.
    const currentStall = (now: number): { reason: string; detail: string } | undefined => {
      let best: { at: number; reason: string; detail: string } | undefined;
      const consider = (at: number, reason: string, detail: string) => {
        if (now >= at && (!best || at < best.at)) best = { at, reason, detail };
      };
      for (const tool of tools.values()) {
        consider(
          tool.startedAt + toolMs,
          "tool-duration",
          `tool ${tool.name} (${tool.id}) exceeded ${toolMs}ms`,
        );
        consider(
          tool.progressAt + silenceMs,
          "silence",
          `tool ${tool.name} (${tool.id}) produced no observable progress for ${silenceMs}ms`,
        );
      }
      if (tools.size === 0)
        consider(
          modelProgressAt + silenceMs,
          "silence",
          `model produced no observable progress for ${silenceMs}ms`,
        );
      return best ? { reason: best.reason, detail: best.detail } : undefined;
    };

    const watchdogDeadline = (): number | undefined => {
      if (finished || settled || aborted) return undefined;
      // During a transient retry backoff only the hard ceiling applies: the
      // phase is intentionally idle, so silence is not a stall.
      if (retryScheduled) return hardDeadline;
      const candidates: number[] = [hardDeadline];
      if (awaitingCheckpoint) {
        candidates.push(checkpointDeadline);
      } else {
        if (!softCheckpointUsed && !continuationUsed) candidates.push(softDeadline);
        // Model silence only applies while the model is the active step; an
        // in-flight tool owns its own silence timer.
        if (tools.size === 0) candidates.push(modelProgressAt + silenceMs);
        for (const tool of tools.values()) {
          candidates.push(tool.progressAt + silenceMs);
          candidates.push(tool.startedAt + toolMs);
        }
      }
      return Math.min(...candidates);
    };
    const refreshWatchdog = () => {
      if (finished) return;
      clearTimer(watchdogTimer);
      watchdogTimer = undefined;
      const deadline = watchdogDeadline();
      if (deadline === undefined) return;
      watchdogTimer = clock.setTimer(onDeadline, Math.max(0, deadline - clock.now()));
    };

    const requestCheckpoint = (reason: string, detail: string) => {
      if (awaitingCheckpoint || aborted || finished) return;
      awaitingCheckpoint = true;
      checkpointReasons.push(`${reason}: ${detail}`);
      checkpointDeadline = Math.min(clock.now() + checkpointGraceMs, hardDeadline);
      modelProgressAt = clock.now();
      notify("checkpoint", reason, detail);
      sendCommand({
        id: CHECKPOINT_STEER_ID,
        type: "steer",
        message: checkpointPrompt(phase, stepDescription(), consumedMs(), lastProgress),
      });
      refreshWatchdog();
    };

    const abortPhase = (reason: string, detail: string) => {
      if (aborted || finished) return;
      aborted = true;
      awaitingCheckpoint = false;
      abortReason = `${reason}: ${detail}`;
      checkpointReasons.push(abortReason);
      clearTimer(watchdogTimer);
      watchdogTimer = undefined;
      // The phase is cancelled; a retry firing during the abort grace must not
      // send another prompt.
      clearTimer(retryTimer);
      retryTimer = undefined;
      retryScheduled = false;
      // Persist the stop explanation before any irreversible abort.
      notify("abort", reason, detail);
      // Queue cleanup first: an abort continues queued messages, which would
      // otherwise replay the checkpoint as a duplicate intervention.
      sendCommand({ id: CLEAR_QUEUE_ID, type: "clear_queue" });
      sendCommand({ id: ABORT_ID, type: "abort" });
      if (abortTimer === undefined) {
        abortTimer = clock.setTimer(() => {
          abortTimer = undefined;
          terminateProcess();
        }, abortGraceMs);
      }
    };

    const onDeadline = () => {
      watchdogTimer = undefined;
      if (finished || settled || aborted) return;
      const now = clock.now();
      if (now >= hardDeadline) {
        abortPhase("hard-ceiling", `phase hard ceiling of ${hardCeilingMs}ms reached`);
        return;
      }
      if (awaitingCheckpoint) {
        if (now >= checkpointDeadline) {
          abortPhase("checkpoint-grace", "checkpoint grace expired without a structured response");
          return;
        }
        refreshWatchdog();
        return;
      }
      const stall = currentStall(now);
      // After the one continuation, a further stall is terminal; no second
      // incomplete outcome and no re-triggered soft checkpoint.
      if (continuationUsed) {
        if (stall) {
          abortPhase(stall.reason, stall.detail);
          return;
        }
        refreshWatchdog();
        return;
      }
      if (!softCheckpointUsed && now >= softDeadline) {
        softCheckpointUsed = true;
        requestCheckpoint("soft-checkpoint", `phase exceeded ${softCheckpointMs}ms`);
        return;
      }
      if (stall) {
        requestCheckpoint(stall.reason, stall.detail);
        return;
      }
      refreshWatchdog();
    };

    const nextPromptId = () => `prompt-${++promptSequence}`;

    /**
     * Start another turn in the same process. Retries, corrections and
     * continuations all reset the per-run bookkeeping (but never the durable
     * phase allowance) and share the same command/settle contract.
     */
    const beginRun = (prompt: string, progress: string) => {
      awaitingCheckpoint = false;
      settled = false;
      accepted = false;
      assistant = "";
      terminal = undefined;
      autoRetryExhausted = false;
      resolvedOutcome = undefined;
      autoRetryFinalError = undefined;
      assistantFailures = 0;
      autoRetryFailure = -1;
      tools.clear();
      modelProgressAt = clock.now();
      lastProgress = progress;
      activePromptId = nextPromptId();
      sendCommand({ id: activePromptId, type: "prompt", message: prompt });
      refreshWatchdog();
    };

    const beginContinuation = (remainingWork: string) => {
      // The continuation is the phase's last allowance: no further checkpoint,
      // and the soft checkpoint is not retriggered.
      softCheckpointUsed = true;
      beginRun(
        continuationPrompt(phase, checkpointReasons.join("; "), remainingWork),
        "continuation started",
      );
    };

    const finishNormally = () => {
      settled = true;
      clearTimer(watchdogTimer);
      watchdogTimer = undefined;
      closeStdin();
      // Give the settled process a bounded chance to exit, then escalate.
      drainTimer = clock.setTimer(terminateProcess, settleGraceMs);
    };

    /**
     * Grant one classified transient retry, waiting out its backoff first.
     * Only Pi's structured native-retry exhaustion qualifies; an unclassified
     * exit or abort never reaches here. Returns false when the budget is spent.
     */
    const scheduleTransientRetry = (detail: string): boolean => {
      if (transientRetries >= transientRetryLimit) return false;
      const index = transientRetries;
      transientRetries += 1;
      retryScheduled = true;
      notify("retry", "transient", detail);
      modelProgressAt = clock.now();
      lastProgress = "transient retry backoff";
      clearTimer(watchdogTimer);
      watchdogTimer = undefined;
      const delay = transientBackoffMs[index] ?? transientBackoffMs.at(-1) ?? 0;
      retryTimer = clock.setTimer(() => {
        retryTimer = undefined;
        retryScheduled = false;
        // The backoff can outlive a stop or the hard ceiling (abort grace may
        // still be running); never dispatch a turn after cancellation.
        if (finished || aborted || failure) return;
        if (clock.now() >= hardDeadline) {
          abortPhase("hard-ceiling", `phase hard ceiling of ${hardCeilingMs}ms reached`);
          return;
        }
        beginRun(transientRetryPrompt(phase, detail), "transient retry started");
      }, delay);
      refreshWatchdog();
      return true;
    };

    /** One same-session correction prompt for an invalid phase response. */
    const beginCorrection = (problem: string) => {
      corrections += 1;
      notify("correction", "invalid-response", problem);
      beginRun(correctionPrompt(phase, problem), "response correction requested");
    };

    // Validate the settled response, allowing one correction before the phase
    // task is allowed to fail. Persistent inconsistency never approves work.
    const resolveAndFinish = () => {
      if (!options.resolveOutcome) {
        finishNormally();
        return;
      }
      try {
        resolvedOutcome = options.resolveOutcome(assistant);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (corrections < 1) {
          beginCorrection(message);
          return;
        }
        stop(`phase response stayed invalid after one correction: ${message}`);
        return;
      }
      finishNormally();
    };

    // Grant the one incomplete continuation, or bound a second incomplete
    // outcome. Applies to controller checkpoints and voluntary incompletes.
    const decideIncomplete = (remainingWork: string) => {
      if (!continuationUsed) {
        continuationUsed = true;
        notify("continuation", "incomplete", remainingWork || "remaining work reported");
        beginContinuation(remainingWork);
        return;
      }
      abortPhase(
        "second-incomplete",
        `phase reported incomplete again after its continuation: ${remainingWork}`,
      );
    };

    const decideCheckpoint = () => {
      awaitingCheckpoint = false;
      let outcome: PhaseOutcome | undefined;
      try {
        outcome = parsePhaseOutcome(phase, assistant);
      } catch {
        outcome = undefined;
      }
      if (outcome?.outcome === "incomplete") {
        decideIncomplete(outcome.remainingWork ?? "");
        return;
      }
      if (outcome?.outcome === "blocked") {
        abortPhase(
          "blocked",
          `phase reported blocked during checkpoint: ${outcome.blockers ?? ""}`,
        );
        return;
      }
      // complete/pass/changes_requested (or an unparseable final message that
      // the caller will reject) ends the phase task.
      resolveAndFinish();
    };

    const handleSettled = () => {
      if (finished || aborted || retryScheduled) return;
      if (!accepted) {
        stop("pi settled before accepting the prompt");
        return;
      }
      // Pi settles failed and aborted responses too. Only a successful final
      // message is authoritative, so valid outcome JSON inside a failed
      // stream cannot approve work.
      if (terminal?.stopReason === "aborted") {
        stop("pi settled after an unsuccessful response (aborted)");
        return;
      }
      if (terminal?.stopReason === "error" || terminal?.errorMessage) {
        // Native-retry evidence only describes the latest assistant failure. A
        // queued turn that fails afterwards must report its own error and must
        // not spend a controller retry on the earlier transient classification.
        const retryEvidenceCurrent = autoRetryFailure === assistantFailures;
        const recorded =
          (retryEvidenceCurrent ? autoRetryFinalError : undefined) ??
          terminal?.errorMessage ??
          terminal?.stopReason ??
          "error";
        const detail = `unsuccessful response (${terminal?.stopReason ?? "error"}: ${recorded})`;
        const exhausted = autoRetryExhausted && retryEvidenceCurrent;
        // A user interruption, a plain exit, or any failure not classified as
        // transient is never retried.
        if (exhausted && scheduleTransientRetry(detail)) return;
        stop(
          `pi settled after an ${detail}${
            exhausted ? " and its transient retries were exhausted" : ""
          }`,
        );
        return;
      }
      if (awaitingCheckpoint) {
        decideCheckpoint();
        return;
      }
      // A worker may report incomplete without waiting for a controller
      // checkpoint; treat it like a checkpoint incomplete so the same single
      // continuation applies and the allowance survives resume.
      let voluntary: PhaseOutcome | undefined;
      try {
        voluntary = parsePhaseOutcome(phase, assistant);
      } catch {
        voluntary = undefined;
      }
      if (voluntary?.outcome === "incomplete") {
        decideIncomplete(voluntary.remainingWork ?? "");
        return;
      }
      resolveAndFinish();
    };

    const handleResponse = (value: Record<string, unknown>) => {
      const command = value.command;
      if (command === "prompt") {
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
        if (value.id === activePromptId) accepted = true;
        return;
      }
      if (command === "clear_queue") {
        const data = value.data as { steering?: unknown; followUp?: unknown } | undefined;
        queuedSteering = stringArray(data?.steering);
        queuedFollowUp = stringArray(data?.followUp);
        return;
      }
      if (command === "abort") {
        if (aborted && !abortAcknowledged) {
          abortAcknowledged = true;
          clearTimer(abortTimer);
          abortTimer = undefined;
          terminateProcess();
        }
      }
    };

    const handleRecord = (record: unknown) => {
      if (!record || typeof record !== "object") return;
      const value = record as Record<string, unknown>;
      if (value.type === "response") {
        handleResponse(value);
        return;
      }
      if (value.type === "agent_settled") {
        handleSettled();
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
            assistantFailures += 1;
            terminal = {
              stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
              errorMessage:
                typeof record.errorMessage === "string" ? record.errorMessage : undefined,
            };
          }
        }
        const text = assistantText(message);
        if (text !== undefined) assistant = text;
        markModelProgress("message completed");
        return;
      }
      if (value.type === "message_update") {
        const event = value.assistantMessageEvent as
          | { type?: unknown; delta?: unknown }
          | undefined;
        const delta = event?.delta;
        if (typeof delta === "string") {
          if (delta.length) markModelProgress("model output");
        } else if (typeof event?.type === "string" && event.type !== "start") {
          markModelProgress("model activity");
        }
        return;
      }
      if (value.type === "tool_execution_start") {
        const id = typeof value.toolCallId === "string" ? value.toolCallId : `tool-${tools.size}`;
        const name = typeof value.toolName === "string" ? value.toolName : "tool";
        const startedAt = clock.now();
        const tool: TrackedTool = { id, name, startedAt, progressAt: startedAt, signature: "" };
        tools.set(id, tool);
        markToolProgress(tool, `started ${name}`);
        return;
      }
      if (value.type === "tool_execution_update") {
        const id = typeof value.toolCallId === "string" ? value.toolCallId : "";
        const tool = tools.get(id);
        if (!tool) return;
        const signature = snapshotSignature(value.partialResult);
        // Duplicate and empty snapshots are not new progress; the absolute
        // per-tool duration cap is enforced independently by the watchdog.
        if (signature !== "" && signature !== tool.signature) {
          tool.signature = signature;
          markToolProgress(tool, `${tool.name} produced output`);
        }
        return;
      }
      if (value.type === "tool_execution_end") {
        const id = typeof value.toolCallId === "string" ? value.toolCallId : "";
        const tool = tools.get(id);
        tools.delete(id);
        // A finished call is model-visible progress even though it is gone.
        markModelProgress(tool ? `finished ${tool.name}` : "tool finished");
        return;
      }
      if (value.type === "auto_retry_start") {
        // Pi's own transient retries stay outside the controller budget.
        markModelProgress("native retry scheduled");
        return;
      }
      if (value.type === "auto_retry_end") {
        // `success: false` covers exhausted retries, a cancelled retry, and a
        // non-retryable error after an earlier retry. Only a classified
        // transient finalError may spend a controller retry; the recorded
        // finalError is preserved for the retry/stop diagnostics.
        autoRetryFinalError = typeof value.finalError === "string" ? value.finalError : undefined;
        autoRetryExhausted =
          value.success === false && isTransientProviderFailure(autoRetryFinalError);
        autoRetryFailure = assistantFailures;
        markModelProgress("native retry finished");
        return;
      }
      if (
        value.type === "message_start" ||
        value.type === "turn_start" ||
        value.type === "turn_end" ||
        value.type === "agent_start" ||
        value.type === "agent_end" ||
        value.type === "compaction_start" ||
        value.type === "compaction_end"
      ) {
        markModelProgress("run activity");
      }
    };

    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);

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
      if (finished) return;
      if (failure) {
        finish(
          new Error(
            `${failure}\n${tailText(stderr, 4000)}${options.log ? `\nLog: ${options.log}` : ""}`,
          ),
        );
        return;
      }
      if (abortReason) {
        const detail = [
          `Worker stopped: ${abortReason}`,
          queuedSteering.length ? `Cleared queued steering: ${queuedSteering.join(" | ")}` : "",
          queuedFollowUp.length ? `Cleared queued follow-up: ${queuedFollowUp.join(" | ")}` : "",
          tailText(stderr, 4000),
          options.log ? `Log: ${options.log}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        finish(new Error(detail));
        return;
      }
      if (settled) {
        finish();
        return;
      }
      const reason = signal ? `${program} terminated by ${signal}` : `${program} exited ${code}`;
      finish(
        new Error(
          `${reason} before the run settled\n${tailText(stderr, 4000)}${options.log ? `\nLog: ${options.log}` : ""}`,
        ),
      );
    });

    if (options.onAccounting) {
      // Persist runtime periodically so a controller crash loses at most one
      // interval instead of replenishing the whole allowance on resume.
      const accountingIntervalMs = Math.max(1_000, Math.min(silenceMs, 60_000));
      accountingTimer = clock.setTimer(function tick() {
        flushAccounting();
        if (!finished) accountingTimer = clock.setTimer(tick, accountingIntervalMs);
      }, accountingIntervalMs);
    }

    refreshWatchdog();
    const recovery = recoveryPrompt(options.recovery);
    sendCommand({
      id: INITIAL_PROMPT_ID,
      type: "prompt",
      message: recovery ? `${recovery}\n\n${options.prompt}` : options.prompt,
    });
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

/**
 * Reject an outcome the controller knows is inconsistent with deterministic
 * evidence. A passing review cannot follow failed required checks, so this
 * becomes a bounded response-correction request rather than an approval.
 */
export function assertOutcomeConsistent(
  phase: WorkerPhase,
  outcome: PhaseOutcome,
  evidence: { checksPassed: boolean },
): void {
  if (phase === "review" && outcome.outcome === "pass" && !evidence.checksPassed)
    throw new Error("a pass cannot be accepted when required checks failed");
}
