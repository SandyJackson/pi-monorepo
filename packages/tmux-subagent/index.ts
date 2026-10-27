/**
 * Pi adapter for tmux subagents. A Pi started with `--subagent-child` runs
 * the child bridge; any other Pi registers the `subagent` tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverProjectAgents,
  discoverUserAgents,
  discoverWorkspaceAgents,
  mergeAgentLists,
} from "./agents.ts";
import { createFollowUpTools } from "./ask-tools.ts";
import { startChildBridge } from "./child.ts";
import { createParentRuntime } from "./parent.ts";
import { createStore } from "./store.ts";
import { createSubagentTool } from "./subagent-tool.ts";

const CHILD_FLAG = "subagent-child";

export default function (pi: ExtensionAPI): void {
  pi.registerFlag(CHILD_FLAG, {
    description: "Internal: run as the subagent child whose state directory is given",
    type: "string",
  });

  // Flags are applied after extension factories run, so mode is decided here.
  pi.on("session_start", (event, ctx) => {
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
    const includeProjectAgents = ctx.isProjectTrusted();
    const agents = mergeAgentLists(
      discoverUserAgents(),
      includeProjectAgents ? discoverProjectAgents(parentCwd) : [],
      discoverWorkspaceAgents(),
    );
    const store = createStore();
    const runtime = createParentRuntime({
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionName: ctx.sessionManager.getSessionName(),
      parentCwd,
      isProjectTrusted: () => ctx.isProjectTrusted(),
      store,
    });
    const [askTool, retrieveTool] = createFollowUpTools({
      ask: runtime.ask,
      retrieveResult: runtime.retrieveResult,
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
        executeDelegation: runtime.delegate,
      }),
    );
  });
}
