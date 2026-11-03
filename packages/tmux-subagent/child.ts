/**
 * child.ts — the child bridge (§8): runs inside a child Pi started with
 * `--subagent-child`, takes requests from the state directory, submits them
 * to Pi, and records each request's own result.
 */

import * as path from "node:path";
import type {
  AgentActivityOutcome,
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { HERDR_BLOCKED_EVENT, isHerdrBlockedPayload } from "@pi-workspace/herdr-contract";
import { Type } from "typebox";
import { isAttached } from "./launch.ts";
import * as text from "./model-text.ts";
import { findRequestAnswer } from "./pi-session.ts";
import {
  type ChildId,
  createStore,
  type RequestRecord,
  type RequestRef,
  type RequestResult,
  type Store,
} from "./store.ts";
import { createTmuxExec, type TmuxExec, tmuxSocket } from "./tmux.ts";

/** How often the bridge looks for a request to dispatch and for `drain`. */
export const POLL_MS = 250;
/** How long Pi has to start or queue a dispatched request. */
export const DISPATCH_MS = 10_000;
/** How long a child started with `drain` present waits for a viewer before it exits. */
export const UNVIEWED_EXIT_MS = 60_000;

/** The request submitted to Pi and not yet settled. */
interface CurrentRequest {
  request: RequestRef;
  instruction: string;
  /** The text Pi started the run with: the instruction after skill and template expansion. */
  requestText: string;
  dispatchLeaf: string | null;
  inputSeen: boolean;
  confirmed: boolean;
  startedAt?: string;
  humanIntervened: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export function startChildBridge(
  pi: ExtensionAPI,
  options: {
    childDir: string;
    nonce: string;
    /** The context and reason of the `session_start` that starts the bridge. */
    ctx: ExtensionContext;
    reason: SessionStartEvent["reason"];
    store?: Store;
    tmux?: TmuxExec;
  },
): void {
  const { nonce, ctx } = options;
  const childId = path.basename(options.childDir);
  const store = options.store ?? createStore(path.dirname(path.dirname(options.childDir)));
  if (!options.tmux) store.bindSocket(tmuxSocket());
  const tmux = options.tmux ?? createTmuxExec();

  let current: CurrentRequest | undefined;
  let agentRunning = !ctx.isIdle();
  let outcome: AgentActivityOutcome | undefined;
  let uiPrompt: { label: string; since: string } | undefined;
  let herdrBlocked: { label: string; since: string } | undefined;

  /** `startedAt` is present only when Pi started the request's run. */
  function settle(request: RequestRef, result: RequestResult, startedAt?: string): void {
    store.writeResult({
      version: 1,
      request,
      nonce,
      phase: "settled",
      ...(startedAt ? { startedAt } : {}),
      settledAt: new Date().toISOString(),
      result,
    });
  }

  function writeStatus(): void {
    const requestId = current?.confirmed ? current.request.requestId : undefined;
    const blocked = uiPrompt ?? herdrBlocked;
    store.writeStatus(childId, {
      version: 1,
      nonce,
      pid: process.pid,
      state: agentRunning ? "running" : "idle",
      ...(requestId ? { current: requestId } : {}),
      ...(blocked ? { blocked } : {}),
    });
  }

  function finish(result: RequestResult): void {
    if (!current) return;
    clearTimeout(current.timer);
    settle(current.request, result, current.startedAt);
    current = undefined;
    writeStatus();
  }

  function confirm(): void {
    if (!current || current.confirmed) return;
    clearTimeout(current.timer);
    current.confirmed = true;
    current.startedAt = new Date().toISOString();
    store.writeResult({
      version: 1,
      request: current.request,
      nonce,
      phase: "running",
      startedAt: current.startedAt,
    });
  }

  /** The lowest request without a result: never started, so safe to dispatch. */
  function nextQueued(): RequestRecord | undefined {
    for (const requestId of store.listRequestIds(childId)) {
      const request = { childId, requestId };
      if (store.readResult(request)) continue;
      try {
        // createRequest renames the directory into place with request.json inside.
        return store.readRequest(request);
      } catch (error) {
        // An unreadable request can never run; settle it so the parent sees why
        // and later requests are not blocked behind it.
        settle(request, {
          status: "failed",
          reason: "error",
          error: text.requestUnreadable(error instanceof Error ? error.message : String(error)),
          humanIntervened: false,
        });
      }
    }
    return undefined;
  }

  /**
   * The dispatch deadline. Never resend: a late start after a resend would run
   * the instruction twice. While Pi is busy after the input, it is still
   * preparing the run (pre-run compaction, `before_agent_start` handlers), so
   * the deadline is re-armed instead.
   */
  function dispatchTimer(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (current?.confirmed !== false) return;
      if (current.inputSeen && !ctx.isIdle()) {
        current.timer = dispatchTimer();
        return;
      }
      finish({
        status: "failed",
        reason: "error",
        error: text.PI_DID_NOT_START,
        humanIntervened: current.humanIntervened,
      });
      exitIfDrained().catch(() => {});
    }, DISPATCH_MS);
  }

  function dispatch(record: RequestRecord): void {
    current = {
      request: record.request,
      instruction: record.instruction,
      requestText: record.instruction,
      dispatchLeaf: ctx.sessionManager.getLeafId(),
      inputSeen: false,
      confirmed: false,
      humanIntervened: false,
      timer: dispatchTimer(),
    };
    // Expanded as typed input is: `/skill:` and prompt templates (§8 Dispatch).
    pi.sendUserMessage(record.instruction, { deliverAs: "followUp", expandPromptTemplates: true });
  }

  function poll(): void {
    if (current || uiPrompt || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const record = nextQueued();
    if (record) dispatch(record);
  }

  // Drain (§8): exit only on a transition, never at startup.
  const startedAt = Date.now();
  const drainAtStart = store.hasDrain(childId);
  let drainSeen = drainAtStart;
  let wasAttached: boolean | undefined;
  let everAttached = false;
  let unviewedChecked = false;
  let watching = false;
  let stopped = false;

  function hasUnsettledRequest(): boolean {
    return store
      .listRequestIds(childId)
      .some((requestId) => store.readResult({ childId, requestId })?.phase !== "settled");
  }

  function mayExit(): boolean {
    return (
      !stopped &&
      store.hasDrain(childId) &&
      ctx.isIdle() &&
      !ctx.hasPendingMessages() &&
      !uiPrompt &&
      !current &&
      !hasUnsettledRequest()
    );
  }

  async function exitIfDrained(): Promise<void> {
    if (!mayExit() || (await isAttached(tmux, childId))) return;
    // Re-checked: work may have arrived while tmux answered.
    if (!mayExit()) return;
    stopped = true;
    ctx.shutdown();
  }

  async function watchDrain(): Promise<void> {
    const present = store.hasDrain(childId);
    const appeared = present && !drainSeen;
    drainSeen = present;
    if (!present) {
      wasAttached = undefined;
      return;
    }
    const attached = await isAttached(tmux, childId);
    const detached = wasAttached === true && !attached;
    wasAttached = attached;
    everAttached ||= attached;
    let unviewed = false;
    if (drainAtStart && !everAttached && !unviewedChecked) {
      unviewed = unviewedChecked = Date.now() - startedAt >= UNVIEWED_EXIT_MS;
    }
    if (appeared || detached || unviewed) await exitIfDrained();
  }

  // Startup: a request still running under another process, or under this
  // one across a reload, lost the binding needed to settle it.
  for (const requestId of store.listRequestIds(childId)) {
    const result = store.readResult({ childId, requestId });
    if (result?.phase !== "running") continue;
    if (result.nonce === nonce && options.reason !== "reload") continue;
    settle(
      result.request,
      {
        status: "failed",
        reason: "interrupted",
        error: text.STOPPED_WHILE_RUNNING,
        humanIntervened: false,
      },
      result.startedAt,
    );
  }
  writeStatus();

  const timer = setInterval(() => {
    try {
      poll();
    } catch {
      // An unreadable record is retried on the next poll; the parent reports it.
    }
    if (watching) return;
    watching = true;
    // A failed check keeps the child; the next poll looks again.
    watchDrain()
      .catch(() => {})
      .finally(() => {
        watching = false;
      });
  }, POLL_MS);

  pi.on("input", (event) => {
    if (!current) return { action: "continue" };
    if (event.source === "interactive") current.humanIntervened = true;
    // Input while Pi is idle means the request's own input never started a run.
    if (!current.confirmed && !event.streamingBehavior) current.inputSeen = false;
    if (!current.confirmed && event.source === "extension" && event.text === current.instruction) {
      if (event.streamingBehavior) {
        // A run started since the idle check. Taken back here, the request
        // never runs, so it stays queued and is dispatched again when idle.
        clearTimeout(current.timer);
        current = undefined;
        return { action: "handled" };
      }
      current.inputSeen = true;
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event) => {
    if (current?.inputSeen && !current.confirmed && event.messageType === "user") {
      current.requestText = event.prompt;
    }
  });

  pi.on("agent_start", () => {
    agentRunning = true;
    outcome = undefined;
    if (current?.inputSeen) confirm();
    writeStatus();
  });

  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
  });

  pi.on("agent_settled", (event, settledCtx) => {
    agentRunning = false;
    settleCurrent(event, settledCtx);
    exitIfDrained().catch(() => {});
  });

  function settleCurrent(event: AgentSettledEvent, settledCtx: ExtensionContext): void {
    const settledOutcome = outcome;
    outcome = undefined;
    if (!current?.confirmed) {
      writeStatus();
      return;
    }
    const { humanIntervened } = current;
    const located = findRequestAnswer(settledCtx.sessionManager.getBranch(), {
      dispatchLeaf: current.dispatchLeaf,
      requestText: current.requestText,
      sessionPath: settledCtx.sessionManager.getSessionFile(),
    });
    if (located.status === "superseded") {
      finish({
        status: "failed",
        reason: "superseded",
        error: text.REQUEST_SUPERSEDED,
        humanIntervened,
      });
    } else if (event.aborted || settledOutcome === "aborted") {
      finish({
        status: "failed",
        reason: "interrupted",
        error: text.RUN_INTERRUPTED,
        humanIntervened,
      });
    } else if (settledOutcome === "error") {
      finish({
        status: "failed",
        reason: "error",
        error: text.RUN_ERROR,
        humanIntervened,
      });
    } else if (settledOutcome === undefined) {
      finish({
        status: "failed",
        reason: "error",
        error: text.NO_SETTLE_OUTCOME,
        humanIntervened,
      });
    } else {
      finish({ status: "completed", answer: located.answer, humanIntervened });
    }
  }

  pi.on("ui_prompt_start", (event) => {
    uiPrompt = { label: event.title ?? "Waiting for input", since: new Date().toISOString() };
    writeStatus();
  });

  pi.on("ui_prompt_end", () => {
    uiPrompt = undefined;
    writeStatus();
  });

  const unsubscribeBlocked = pi.events.on(HERDR_BLOCKED_EVENT, (payload) => {
    if (!isHerdrBlockedPayload(payload)) return;
    herdrBlocked = payload.active
      ? { label: payload.label ?? "Blocked", since: new Date().toISOString() }
      : undefined;
    writeStatus();
  });

  pi.on("session_shutdown", () => {
    stopped = true;
    clearInterval(timer);
    if (current) clearTimeout(current.timer);
    unsubscribeBlocked();
  });
}

const ReportParams = Type.Object(
  {
    content: Type.String({ minLength: 1, description: text.REPORT_CONTENT_PARAM }),
  },
  { additionalProperties: false },
);

/**
 * `subagent_report` (§8): queue a report for the parent named in this
 * child's `child.json`. The model supplies only the content.
 */
export function createReportTool(options: {
  store: Store;
  childId: ChildId;
}): ToolDefinition<typeof ReportParams> {
  return {
    name: "subagent_report",
    label: text.REPORT_LABEL,
    description: text.REPORT_DESCRIPTION,
    parameters: ReportParams,
    async execute(_toolCallId, params) {
      if (!params.content.trim()) throw new Error(text.REPORT_CONTENT_EMPTY);
      const child = options.store.readChild(options.childId);
      const { reportId } = options.store.createReport({
        childId: child.childId,
        parentSessionId: child.parent.sessionId,
        agent: child.agent.name,
        content: params.content,
      });
      return {
        content: [{ type: "text", text: text.reportQueued(reportId) }],
        details: undefined,
      };
    },
  };
}
