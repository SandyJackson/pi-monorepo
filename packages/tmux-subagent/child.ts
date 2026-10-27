/**
 * child.ts — the child bridge (§8): runs inside a child Pi started with
 * `--subagent-child`, takes requests from the state directory, submits them
 * to Pi, and records each request's own result.
 */

import * as path from "node:path";
import type {
  AgentActivityOutcome,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { HERDR_BLOCKED_EVENT, isHerdrBlockedPayload } from "@pi-workspace/herdr-contract";
import { findRequestAnswer } from "./pi-session.ts";
import {
  createStore,
  type RequestRecord,
  type RequestRef,
  type RequestResult,
  type Store,
} from "./store.ts";

/** How often the bridge looks for a request to dispatch. */
export const POLL_MS = 250;
/** How long Pi has to start or queue a dispatched request. */
export const DISPATCH_MS = 10_000;

/** The request submitted to Pi and not yet settled. */
interface CurrentRequest {
  request: RequestRef;
  instruction: string;
  dispatchLeaf: string | null;
  inputSeen: boolean;
  confirmed: boolean;
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
  },
): void {
  const { nonce, ctx } = options;
  const childId = path.basename(options.childDir);
  const store = options.store ?? createStore(path.dirname(path.dirname(options.childDir)));

  let current: CurrentRequest | undefined;
  let outcome: AgentActivityOutcome | undefined;
  let uiPrompt: { label: string; since: string } | undefined;
  let herdrBlocked: { label: string; since: string } | undefined;

  function settle(request: RequestRef, result: RequestResult): void {
    store.writeResult({
      version: 1,
      request,
      nonce,
      phase: "settled",
      settledAt: new Date().toISOString(),
      result,
    });
  }

  function writeStatus(): void {
    const running = current?.confirmed ? current.request.requestId : undefined;
    const blocked = uiPrompt ?? herdrBlocked;
    store.writeStatus(childId, {
      version: 1,
      nonce,
      pid: process.pid,
      state: running ? "running" : "idle",
      ...(running ? { current: running } : {}),
      ...(blocked ? { blocked } : {}),
    });
  }

  function finish(result: RequestResult): void {
    if (!current) return;
    clearTimeout(current.timer);
    settle(current.request, result);
    current = undefined;
    writeStatus();
  }

  function confirm(): void {
    if (!current || current.confirmed) return;
    clearTimeout(current.timer);
    current.confirmed = true;
    store.writeResult({
      version: 1,
      request: current.request,
      nonce,
      phase: "running",
      startedAt: new Date().toISOString(),
    });
    writeStatus();
  }

  /** The lowest request without a result: never started, so safe to dispatch. */
  function nextQueued(): RequestRecord | undefined {
    for (const requestId of store.listRequestIds(childId)) {
      const request = { childId, requestId };
      if (store.readResult(request)) continue;
      return store.readRequest(request);
    }
    return undefined;
  }

  function dispatch(record: RequestRecord): void {
    current = {
      request: record.request,
      instruction: record.instruction,
      dispatchLeaf: ctx.sessionManager.getLeafId(),
      inputSeen: false,
      confirmed: false,
      humanIntervened: false,
      // Never resend: a late start after a resend would run the instruction twice.
      timer: setTimeout(() => {
        if (current?.confirmed === false) {
          finish({
            status: "failed",
            reason: "error",
            error: "Pi did not start the request",
            humanIntervened: current.humanIntervened,
          });
        }
      }, DISPATCH_MS),
    };
    pi.sendUserMessage(record.instruction, { deliverAs: "followUp" });
  }

  function poll(): void {
    if (current || uiPrompt || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const record = nextQueued();
    if (record) dispatch(record);
  }

  // Startup: a request still running under another process, or under this
  // one across a reload, lost the binding needed to settle it.
  for (const requestId of store.listRequestIds(childId)) {
    const result = store.readResult({ childId, requestId });
    if (result?.phase !== "running") continue;
    if (result.nonce === nonce && options.reason !== "reload") continue;
    settle(result.request, {
      status: "failed",
      reason: "interrupted",
      error: "The child stopped while this request was running.",
      humanIntervened: false,
    });
  }
  writeStatus();

  const timer = setInterval(() => {
    try {
      poll();
    } catch {
      // An unreadable record is retried on the next poll; the parent reports it.
    }
  }, POLL_MS);

  pi.on("input", (event) => {
    if (!current) return { action: "continue" };
    if (event.source === "interactive") current.humanIntervened = true;
    if (!current.confirmed && event.source === "extension" && event.text === current.instruction) {
      current.inputSeen = true;
      // Pi was streaming and queued the request as a follow-up.
      if (event.streamingBehavior) confirm();
    }
    return { action: "continue" };
  });

  pi.on("agent_start", () => {
    outcome = undefined;
    if (current?.inputSeen) confirm();
  });

  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
  });

  pi.on("agent_settled", (event, settledCtx) => {
    const settledOutcome = outcome;
    outcome = undefined;
    if (!current?.confirmed) return;
    const { humanIntervened } = current;
    const located = findRequestAnswer(settledCtx.sessionManager.getBranch(), {
      dispatchLeaf: current.dispatchLeaf,
      instruction: current.instruction,
      sessionPath: settledCtx.sessionManager.getSessionFile(),
    });
    if (located.status === "superseded") {
      finish({
        status: "failed",
        reason: "superseded",
        error: "The request's message is no longer on the child's active branch.",
        humanIntervened,
      });
    } else if (event.aborted || settledOutcome === "aborted") {
      finish({
        status: "failed",
        reason: "interrupted",
        error: "The run was interrupted inside the child.",
        humanIntervened,
      });
    } else if (settledOutcome === "error") {
      finish({
        status: "failed",
        reason: "error",
        error: "The child's run ended with an error.",
        humanIntervened,
      });
    } else if (settledOutcome === undefined) {
      finish({
        status: "failed",
        reason: "error",
        error: "Pi settled without an outcome",
        humanIntervened,
      });
    } else {
      finish({ status: "completed", answer: located.answer, humanIntervened });
    }
  });

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
    clearInterval(timer);
    if (current) clearTimeout(current.timer);
    unsubscribeBlocked();
  });
}
