/**
 * Pi adapter for tmux subagents. A Pi started with `--subagent-child` runs
 * the child bridge; any other Pi registers the `subagent` tool.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverProjectAgents,
  discoverUserAgents,
  discoverWorkspaceAgents,
  mergeAgentLists,
} from "./agents.ts";
import { createReportTool, startChildBridge } from "./child.ts";
import {
  createParentRuntime,
  deliveredReportKeys,
  type ParentRuntime,
  reportEnvelope,
} from "./parent.ts";
import { createStore } from "./store.ts";
import { createSubagentTool } from "./subagent-tool.ts";

const CHILD_FLAG = "subagent-child";

export default function (pi: ExtensionAPI): void {
  pi.registerFlag(CHILD_FLAG, {
    description: "Internal: run as the subagent child whose state directory is given",
    type: "string",
  });

  // The parent runtime of the active session; replaced on each session_start.
  let runtime: ParentRuntime | undefined;

  // Flags are applied after extension factories run, so mode is decided here.
  pi.on("session_start", (event, ctx) => {
    const childDir = pi.getFlag(CHILD_FLAG);
    if (typeof childDir === "string" && childDir) {
      // Left in the environment so /reload, in the same process, reads the same nonce.
      const nonce = process.env.PI_SUBAGENT_NONCE;
      if (!nonce) {
        throw new Error(`--${CHILD_FLAG} requires PI_SUBAGENT_NONCE from the subagent launcher.`);
      }
      const store = createStore(path.dirname(path.dirname(childDir)));
      startChildBridge(pi, { childDir, nonce, ctx, reason: event.reason, store });
      pi.registerTool(createReportTool({ store, childId: path.basename(childDir) }));
      return;
    }

    const parentCwd = ctx.cwd;
    const includeProjectAgents = ctx.isProjectTrusted();
    const agents = mergeAgentLists(
      discoverUserAgents(),
      includeProjectAgents ? discoverProjectAgents(parentCwd) : [],
      discoverWorkspaceAgents(),
    );
    runtime?.dispose();
    runtime = createParentRuntime({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionName: ctx.sessionManager.getSessionName(),
      parentCwd,
      isProjectTrusted: () => ctx.isProjectTrusted(),
      deliveredReports: deliveredReportKeys(ctx.sessionManager.getEntries()),
      sendReport: (report) =>
        pi.sendMessage(
          {
            customType: "subagent_report",
            content: reportEnvelope(report),
            display: true,
            details: { childId: report.childId, reportId: report.reportId },
          },
          { deliverAs: "followUp", triggerTurn: true },
        ),
      isIdle: () => ctx.isIdle() && !ctx.hasPendingMessages(),
    });
    pi.registerTool(
      createSubagentTool({
        agents,
        parentCwd,
        includeProjectAgents,
        executeDelegation: runtime.delegate,
      }),
    );
  });

  pi.on("message_end", (event) => {
    runtime?.observeMessage(event.message);
  });

  pi.on("session_shutdown", () => {
    runtime?.dispose();
    runtime = undefined;
  });
}
