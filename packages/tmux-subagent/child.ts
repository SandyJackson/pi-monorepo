/**
 * child.ts — the child bridge (§8): runs inside a child Pi started with
 * `--subagent-child`, takes requests from the state directory, submits them
 * to Pi, and records each request's own result.
 */

import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createStore, type RequestResult, type ResultRecord, type Store } from "./store.ts";

/** How often the bridge looks for a request to dispatch. */
export const POLL_MS = 250;

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
  const { nonce } = options;
  const childId = path.basename(options.childDir);
  const store = options.store ?? createStore(path.dirname(path.dirname(options.childDir)));

  function settle(record: ResultRecord, result: RequestResult): void {
    store.writeResult({
      version: 1,
      request: record.request,
      nonce,
      phase: "settled",
      settledAt: new Date().toISOString(),
      result,
    });
  }

  function writeStatus(): void {
    store.writeStatus(childId, { version: 1, nonce, pid: process.pid, state: "idle" });
  }

  // Startup: a request still running under another process, or under this
  // one across a reload, lost the binding needed to settle it.
  for (const requestId of store.listRequestIds(childId)) {
    const result = store.readResult({ childId, requestId });
    if (result?.phase !== "running") continue;
    if (result.nonce === nonce && options.reason !== "reload") continue;
    settle(result, {
      status: "failed",
      reason: "interrupted",
      error: "The child stopped while this request was running.",
      humanIntervened: false,
    });
  }
  writeStatus();

  const timer = setInterval(() => {}, POLL_MS);
  pi.on("session_shutdown", () => {
    clearInterval(timer);
  });
}
