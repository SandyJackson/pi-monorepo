/**
 * Pi adapter for tmux subagents. A Pi started with `--subagent-child` runs
 * the child bridge; any other Pi, and a depth-1 child, registers the parent
 * tools and drains its children when it departs the conversation.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  discoverProjectAgents,
  discoverUserAgents,
  discoverWorkspaceAgents,
  mergeAgentLists,
} from "./agents.ts";
import { createFollowUpTools } from "./ask-tools.ts";
import { createReportTool, startChildBridge } from "./child.ts";
import {
  clearDrain,
  createParentRuntime,
  type DrainResult,
  deliveredReportKeys,
  type ParentRuntime,
  REPORT_TYPE,
  reportEnvelope,
} from "./parent.ts";
import { createStore, type Store } from "./store.ts";
import { createSubagentTool } from "./subagent-tool.ts";

const CHILD_FLAG = "subagent-child";

/** Shutdown has no caller to report to, so failures go to stderr and are never shown as success. */
function logFailures(action: string, result: DrainResult): void {
  if (result.error) console.error(`Subagents: could not ${action} children: ${result.error}`);
  for (const { childId, error } of result.failed) {
    console.error(`Subagents: could not ${action} child ${childId}: ${error}`);
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerFlag(CHILD_FLAG, {
    description: "Internal: run as the subagent child whose state directory is given",
    type: "string",
  });

  // The parent runtime of the active session; replaced on each session_start.
  let runtime: ParentRuntime | undefined;

  /** Register the parent tools and start a parent runtime for this session (§6). */
  function startParent(
    ctx: ExtensionContext,
    store: Store,
    creator?: { worktree: string },
  ): ParentRuntime {
    const parentCwd = ctx.cwd;
    const parentSessionId = ctx.sessionManager.getSessionId();
    const includeProjectAgents = ctx.isProjectTrusted();
    const agents = mergeAgentLists(
      discoverUserAgents(),
      includeProjectAgents ? discoverProjectAgents(parentCwd) : [],
      discoverWorkspaceAgents(),
    );
    const parent = createParentRuntime({
      parentSessionId,
      parentSessionName: ctx.sessionManager.getSessionName(),
      parentCwd,
      creator,
      isProjectTrusted: () => ctx.isProjectTrusted(),
      deliveredReports: deliveredReportKeys(ctx.sessionManager.getEntries()),
      sendReport: (report) =>
        pi.sendMessage(
          {
            customType: REPORT_TYPE,
            content: reportEnvelope(report),
            display: true,
            details: { childId: report.childId, reportId: report.reportId },
          },
          { deliverAs: "followUp", triggerTurn: true },
        ),
      isIdle: () => ctx.isIdle() && !ctx.hasPendingMessages(),
      store,
    });
    // A returning parent cancels its earlier departure.
    logFailures("clear drain for", clearDrain({ parentSessionId, store }));
    const [askTool, retrieveTool] = createFollowUpTools({
      ask: parent.ask,
      retrieveResult: parent.retrieveResult,
      defaultTimeoutMinutes: (childId) => {
        try {
          return store.readChild(childId).agent.timeoutMinutes;
        } catch {
          // The runtime reports the unreadable child itself.
          return undefined;
        }
      },
    });
    pi.registerTool(askTool);
    pi.registerTool(retrieveTool);
    pi.registerTool(
      createSubagentTool({
        agents,
        parentCwd,
        includeProjectAgents,
        executeDelegation: parent.delegate,
      }),
    );
    return parent;
  }

  // Flags are applied after extension factories run, so mode is decided here.
  pi.on("session_start", (event, ctx) => {
    runtime?.dispose();
    runtime = undefined;
    const childDir = pi.getFlag(CHILD_FLAG);
    if (typeof childDir !== "string" || !childDir) {
      runtime = startParent(ctx, createStore());
      return;
    }

    // Left in the environment so /reload, in the same process, reads the same nonce.
    const nonce = process.env.PI_SUBAGENT_NONCE;
    if (!nonce) {
      throw new Error(`--${CHILD_FLAG} requires PI_SUBAGENT_NONCE from the subagent launcher.`);
    }
    const store = createStore(path.dirname(path.dirname(childDir)));
    const childId = path.basename(childDir);
    startChildBridge(pi, { childDir, nonce, ctx, reason: event.reason, store });
    pi.registerTool(createReportTool({ store, childId }));
    // A depth-1 child is also a parent to its own children (§8 Nesting); depth 2 is the limit.
    const child = store.readChild(childId);
    if (child.depth === 1) runtime = startParent(ctx, store, { worktree: child.worktree });
  });

  pi.on("message_end", (event) => {
    runtime?.observeMessage(event.message);
  });

  // Reload is never a departure. Every other reason leaves this conversation.
  pi.on("session_shutdown", (event) => {
    const departing = runtime;
    runtime = undefined;
    departing?.dispose();
    if (!departing || event.reason === "reload") return;
    logFailures("drain", departing.drain());
  });
}
