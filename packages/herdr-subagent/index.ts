import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { discoverProjectAgents, discoverUserAgents, mergeAgentLists } from "./agents.ts";
import { executeHerdrDelegation, herdrDelegationEnvironment } from "./herdr/delegation.ts";
import { createSubagentTool } from "./subagent-tool.ts";

/** Register one subagent tool from the callable agent catalog snapshotted for this Pi session. */
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const parentCwd = ctx.cwd;
    const includeProjectAgents = ctx.isProjectTrusted();
    const agents = mergeAgentLists(
      discoverUserAgents(),
      includeProjectAgents ? discoverProjectAgents(parentCwd) : [],
    );

    pi.registerTool(
      createSubagentTool({
        agents,
        parentCwd,
        includeProjectAgents,
        executeDelegation: (tasks, options) =>
          executeHerdrDelegation(tasks, {
            ...herdrDelegationEnvironment(),
            ...options,
          }),
      }),
    );
  });
}
