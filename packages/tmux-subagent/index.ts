/**
 * Pi adapter for tmux subagents. A Pi started with `--subagent-child` runs
 * the child bridge; any other Pi registers the `subagent` tool and drains its
 * children when it departs the conversation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverProjectAgents,
  discoverUserAgents,
  discoverWorkspaceAgents,
  mergeAgentLists,
} from "./agents.ts";
import { startChildBridge } from "./child.ts";
import { clearDrain, createParentRuntime, type DrainResult, type ParentRuntime } from "./parent.ts";
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

  let runtime: ParentRuntime | undefined;

  // Flags are applied after extension factories run, so mode is decided here.
  pi.on("session_start", (event, ctx) => {
    runtime = undefined;
    const childDir = pi.getFlag(CHILD_FLAG);
    if (typeof childDir === "string" && childDir) {
      // Left in the environment so /reload, in the same process, reads the same nonce.
      const nonce = process.env.PI_SUBAGENT_NONCE;
      if (!nonce) {
        throw new Error(`--${CHILD_FLAG} requires PI_SUBAGENT_NONCE from the subagent launcher.`);
      }
      startChildBridge(pi, { childDir, nonce, ctx, reason: event.reason });
      return;
    }

    const parentCwd = ctx.cwd;
    const parentSessionId = ctx.sessionManager.getSessionId();
    const includeProjectAgents = ctx.isProjectTrusted();
    const agents = mergeAgentLists(
      discoverUserAgents(),
      includeProjectAgents ? discoverProjectAgents(parentCwd) : [],
      discoverWorkspaceAgents(),
    );
    runtime = createParentRuntime({
      parentSessionId,
      parentSessionName: ctx.sessionManager.getSessionName(),
      parentCwd,
      isProjectTrusted: () => ctx.isProjectTrusted(),
    });
    // A returning parent cancels its earlier departure.
    logFailures("clear drain for", clearDrain({ parentSessionId }));
    pi.registerTool(
      createSubagentTool({
        agents,
        parentCwd,
        includeProjectAgents,
        executeDelegation: runtime.delegate,
      }),
    );
  });

  // Reload is never a departure. Every other reason leaves this conversation.
  pi.on("session_shutdown", (event) => {
    const departing = runtime;
    runtime = undefined;
    if (!departing || event.reason === "reload") return;
    logFailures("drain", departing.drain());
  });
}
