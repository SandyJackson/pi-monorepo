/**
 * parent.ts — the parent runtime (§6): initial delegation, follow-ups
 * (`ask`), result retrieval, and the wait loop they share.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { ensureLive, isDirectory, isLive, sleep } from "./launch.ts";
import type { SessionAnswerRef } from "./pi-session.ts";
import {
  type ChildId,
  type ChildRecord,
  createStore,
  type RequestRef,
  type RequestResult,
  type Store,
} from "./store.ts";
import { createTmuxExec, projectTrustFor, type TmuxExec } from "./tmux.ts";

// ---------------------------------------------------------------------------
// Delegation types (§5)
// ---------------------------------------------------------------------------

/** Maximum number of valid delegated tasks per delegation. */
export const MAX_DELEGATED_TASKS = 8;

/** Default per-task timeout in minutes, measured from the child's readiness. */
export const DEFAULT_TURN_TIMEOUT_MINUTES = 60;

/** How often a wait reads the request's result and the child's liveness. */
export const POLL_MS = 500;

export interface DelegatedTask {
  agent: string;
  instruction: string;
  cwd: string;
  config: AgentConfig;
}

/** A delegated task carrying its canonical one-based delegation-scoped number. */
export type DelegatedTaskRecord = DelegatedTask & {
  taskNumber: number;
  /** Effective timeout for this task, overriding the delegation default. */
  timeoutMs?: number;
};

export type DelegatedTaskOutcome =
  | {
      status: "completed";
      request: RequestRef;
      answer: SessionAnswerRef | null;
      humanIntervened: boolean;
    }
  | {
      status: "failed";
      request: RequestRef;
      reason: "error" | "interrupted" | "superseded";
      error: string;
    }
  | { status: "timed_out"; request: RequestRef }
  | { status: "aborted"; stage: "before_launch" }
  | { status: "aborted"; stage: "observing"; request: RequestRef }
  | { status: "session_closed"; request: RequestRef }
  | { status: "launch_failed"; childId?: ChildId; error: string }
  | { status: "launch_indeterminate"; request: RequestRef; error: string }
  | { status: "observation_failed"; request: RequestRef; error: string };

/** The single terminal outcome of one delegated task, paired with its record. */
export interface DelegatedTaskExecution {
  task: DelegatedTaskRecord;
  outcome: DelegatedTaskOutcome;
}

export type ExecuteDelegation = (
  tasks: readonly DelegatedTaskRecord[],
  options: {
    /** Purpose label recorded with each child. */
    label?: string;
    signal?: AbortSignal;
    onProgress?: (update: { taskNumber: number; line: string }) => void;
  },
) => Promise<DelegatedTaskExecution[]>;

// ---------------------------------------------------------------------------
// Waiting (§6 retrieveResult)
// ---------------------------------------------------------------------------

type PendingState = "queued" | "running" | "blocked";

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (update: { request: RequestRef; state: PendingState }) => void;
}

/** One attempt by a parent to obtain a request result. */
export type RetrievalOutcome =
  | { status: "settled"; request: RequestRef; result: RequestResult }
  | {
      status: "pending";
      request: RequestRef;
      state: PendingState;
      stopped: "timed_out" | "aborted";
    }
  | { status: "lost"; request: RequestRef; started: boolean };

/**
 * Poll one request until it settles, the timeout passes, the signal aborts,
 * or the child is confirmed gone. Never writes requests or launches. An
 * unreadable or invalid record throws.
 */
async function waitForResult(
  request: RequestRef,
  options: WaitOptions,
  deps: { store: Store; tmux: TmuxExec },
): Promise<RetrievalOutcome> {
  const deadline = Date.now() + options.timeoutMs;
  let state: PendingState | undefined;
  let absentPolls = 0;
  for (;;) {
    const result = deps.store.readResult(request);
    if (result?.phase === "settled") return { status: "settled", request, result: result.result };

    if (await isLive(deps.tmux, request.childId)) {
      absentPolls = 0;
      let next: PendingState = "queued";
      if (result) {
        const status = deps.store.readStatus(request.childId);
        next = status?.nonce === result.nonce && status.blocked ? "blocked" : "running";
      }
      if (next !== state) options.onProgress?.({ request, state: next });
      state = next;
    } else if (++absentPolls >= 2) {
      // Two polls: a result written just before the process exits is not loss.
      return { status: "lost", request, started: result !== undefined };
    }

    const stopped = options.signal?.aborted
      ? "aborted"
      : Date.now() >= deadline
        ? "timed_out"
        : undefined;
    if (stopped) return { status: "pending", request, state: state ?? "queued", stopped };
    await sleep(Math.min(POLL_MS, deadline - Date.now()), options.signal);
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** Outcome of subagent_ask. */
export type AskOutcome =
  | {
      status: "rejected";
      childId: ChildId;
      reason: "invalid_target" | "busy" | "resume_failed" | "aborted";
      error: string;
    }
  | { status: "submitted"; request: RequestRef; retrieval: RetrievalOutcome };

export interface ParentRuntime {
  delegate: ExecuteDelegation;
  /** Send a follow-up to an owned child, resuming it if stopped, and wait for its result. */
  ask(childId: ChildId, instruction: string, options: WaitOptions): Promise<AskOutcome>;
  /** Wait for a recorded result with a fresh timeout. Never submits or launches. */
  retrieveResult(request: RequestRef, options: WaitOptions): Promise<RetrievalOutcome>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonical(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The owning worktree (§3): the Git top level of `cwd`, or `cwd` outside Git. */
function owningWorktree(cwd: string): string {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return canonical(topLevel.trim());
  } catch {
    return canonical(cwd);
  }
}

/** Strip control characters except newline and tab; the instruction travels in a file. */
function sanitizeInstruction(instruction: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control characters
  return instruction.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function toDelegatedOutcome(outcome: RetrievalOutcome): DelegatedTaskOutcome {
  const { request } = outcome;
  switch (outcome.status) {
    case "settled": {
      const { result } = outcome;
      return result.status === "completed"
        ? {
            status: "completed",
            request,
            answer: result.answer,
            humanIntervened: result.humanIntervened,
          }
        : { status: "failed", request, reason: result.reason, error: result.error };
    }
    case "pending":
      return outcome.stopped === "timed_out"
        ? { status: "timed_out", request }
        : { status: "aborted", stage: "observing", request };
    case "lost":
      return { status: "session_closed", request };
  }
}

export function createParentRuntime(options: {
  parentSessionId: string;
  parentSessionName?: string;
  parentCwd: string;
  /** Whether the parent's project is trusted now (`ctx.isProjectTrusted()`). */
  isProjectTrusted: () => boolean;
  store?: Store;
  tmux?: TmuxExec;
}): ParentRuntime {
  const store = options.store ?? createStore();
  const tmux = options.tmux ?? createTmuxExec();

  /** Shared failures before any child exists throw rather than becoming outcomes. */
  async function preflight(): Promise<void> {
    try {
      await tmux(["-V"]);
    } catch (error) {
      throw new Error(`tmux is required for subagents and could not be run: ${message(error)}`);
    }
    try {
      fs.mkdirSync(store.root, { recursive: true, mode: 0o700 });
      fs.accessSync(store.root, fs.constants.W_OK);
    } catch (error) {
      throw new Error(`The subagent state directory is not writable: ${message(error)}`);
    }
  }

  const delegate: ExecuteDelegation = async (tasks, { label, signal, onProgress }) => {
    if (tasks.length > MAX_DELEGATED_TASKS) {
      throw new Error(`Too many delegated tasks (${tasks.length}). Max is ${MAX_DELEGATED_TASKS}.`);
    }
    if (tasks.length === 0) return [];
    if (signal?.aborted) {
      return tasks.map((task) => ({
        task,
        outcome: { status: "aborted", stage: "before_launch" },
      }));
    }
    await preflight();

    const parentCwd = canonical(options.parentCwd);
    const worktree = owningWorktree(parentCwd);
    const parentTrusted = options.isProjectTrusted();
    const outcomes: Array<Promise<DelegatedTaskOutcome>> = [];

    for (const task of tasks) {
      // The last cancellation check before the child exists.
      if (signal?.aborted) {
        outcomes.push(Promise.resolve({ status: "aborted", stage: "before_launch" }));
        continue;
      }
      let childId: ChildId | undefined;
      let request: RequestRef;
      try {
        const cwd = canonical(path.resolve(parentCwd, task.cwd));
        childId = store.createChild(
          {
            parent: { sessionId: options.parentSessionId, name: options.parentSessionName },
            worktree,
            cwd,
            agent: {
              name: task.config.name,
              source: task.config.source,
              model: task.config.model,
              thinking: task.config.thinking,
              tools: task.config.tools,
              timeoutMinutes: task.config.timeout,
            },
            projectTrust: projectTrustFor({ parentTrusted, parentCwd, cwd }),
            label,
            taskNumber: task.taskNumber,
            depth: 1,
            piCommand: [process.execPath, process.argv[1]],
          },
          task.config.systemPromptBody,
        ).childId;
        request = store.createRequest(childId, sanitizeInstruction(task.instruction)).request;
      } catch (error) {
        outcomes.push(Promise.resolve({ status: "launch_failed", childId, error: message(error) }));
        continue;
      }

      const live = await ensureLive(childId, { store, tmux }).catch(
        (error: unknown) => ({ status: "failed", error: message(error) }) as const,
      );
      if (live.status === "failed") {
        outcomes.push(Promise.resolve({ status: "launch_failed", childId, error: live.error }));
        continue;
      }
      if (live.status === "indeterminate") {
        outcomes.push(
          Promise.resolve({ status: "launch_indeterminate", request, error: live.error }),
        );
        continue;
      }

      // The timeout is measured from readiness; later tasks launch without waiting.
      const wait = waitForResult(
        request,
        {
          timeoutMs: task.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MINUTES * 60_000,
          signal,
          onProgress: (update) =>
            onProgress?.({
              taskNumber: task.taskNumber,
              line: `Child ${update.request.childId}, request ${update.request.requestId}: ${update.state}`,
            }),
        },
        { store, tmux },
      ).then(toDelegatedOutcome, (error: unknown) => ({
        status: "observation_failed" as const,
        request,
        error: message(error),
      }));
      outcomes.push(wait);
    }

    const settled = await Promise.all(outcomes);
    return tasks.map((task, index) => ({ task, outcome: settled[index] }));
  };

  /** A child of this parent session; ownership is never inferred from the terminal. */
  function ownedChild(childId: ChildId): ChildRecord {
    const child = store.readChild(childId);
    if (child.parent.sessionId !== options.parentSessionId) {
      throw new Error(`Child ${childId} belongs to another parent session.`);
    }
    return child;
  }

  async function retrieveResult(
    request: RequestRef,
    waitOptions: WaitOptions,
  ): Promise<RetrievalOutcome> {
    ownedChild(request.childId);
    if (!store.readRequest(request)) {
      throw new Error(`Child ${request.childId} has no request ${request.requestId}.`);
    }
    return waitForResult(request, waitOptions, { store, tmux });
  }

  async function ask(
    childId: ChildId,
    instruction: string,
    waitOptions: WaitOptions,
  ): Promise<AskOutcome> {
    const reject = (
      reason: Extract<AskOutcome, { status: "rejected" }>["reason"],
      error: string,
    ): AskOutcome => ({ status: "rejected", childId, reason, error });

    let problem: string | undefined;
    try {
      problem = askProblem(ownedChild(childId));
    } catch (error) {
      problem = message(error);
    }
    if (problem) return reject("invalid_target", problem);

    if (!(await isLive(tmux, childId))) {
      // Readiness means the bridge has already marked a stale running request interrupted.
      const live = await ensureLive(childId, { store, tmux }).catch(
        (error: unknown) => ({ status: "failed", error: message(error) }) as const,
      );
      if (live.status !== "live") {
        return reject("resume_failed", `Child ${childId} could not be resumed: ${live.error}`);
      }
    }

    // From here to the write there is no await, so concurrent asks in this
    // process cannot both pass the capacity check: the parent is the only writer.
    const unsettled = store
      .listRequestIds(childId)
      .filter((requestId) => store.readResult({ childId, requestId })?.phase !== "settled");
    if (unsettled.length >= 2) {
      return reject(
        "busy",
        `Child ${childId} already has a request running and one queued. Nothing was submitted.`,
      );
    }
    if (waitOptions.signal?.aborted) {
      return reject("aborted", "The request was aborted before it was submitted.");
    }
    // The rename inside createRequest is the submission point.
    const { request } = store.createRequest(childId, sanitizeInstruction(instruction));

    try {
      return {
        status: "submitted",
        request,
        retrieval: await waitForResult(request, waitOptions, { store, tmux }),
      };
    } catch (error) {
      throw new Error(
        `Child ${childId}, request ${request.requestId} was submitted, but observing it failed: ${message(error)}`,
      );
    }
  }

  /** Why `ask` cannot use this child, or undefined when it can. */
  function askProblem(child: ChildRecord): string | undefined {
    if (!isDirectory(child.cwd)) {
      return `Child ${child.childId} cannot be resumed: its cwd ${child.cwd} no longer exists. Delegate a new task instead.`;
    }
    if (hasStarted(child.childId) && !hasSessionFile(child.childId)) {
      return `Child ${child.childId} cannot be resumed: its Pi session file is missing. Delegate a new task instead.`;
    }
    if ((child.agent.source === "project" || child.projectTrust) && !options.isProjectTrusted()) {
      return `Child ${child.childId} needs project trust, and the parent project is no longer trusted. Use /trust to trust this project, or delegate a new task.`;
    }
    return undefined;
  }

  /** Whether any request has started, so Pi has written the conversation to disk. */
  function hasStarted(childId: ChildId): boolean {
    return store
      .listRequestIds(childId)
      .some((requestId) => store.readResult({ childId, requestId }) !== undefined);
  }

  function hasSessionFile(childId: ChildId): boolean {
    try {
      return fs
        .readdirSync(path.join(store.childDir(childId), "session"))
        .some((name) => name.endsWith(`_${childId}.jsonl`));
    } catch {
      return false;
    }
  }

  return { delegate, ask, retrieveResult };
}
