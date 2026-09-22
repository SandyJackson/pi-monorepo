import * as fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { discoverProjectAgents, discoverUserAgents, mergeAgentLists } from "./agents.ts";
import { executeHerdrDelegation, herdrDelegationEnvironment } from "./herdr/delegation.ts";
import { DELEGATED_TASK_INPUT_PREFIX } from "./herdr/session.ts";
import { createSubagentTool } from "./subagent-tool.ts";

function registerDelegatedTaskInput(pi: ExtensionAPI): void {
  pi.on("input", (event) => {
    if (event.source !== "interactive" || !event.text.startsWith(DELEGATED_TASK_INPUT_PREFIX)) {
      return { action: "continue" };
    }
    const taskFile = event.text.slice(DELEGATED_TASK_INPUT_PREFIX.length);
    return { action: "transform", text: fs.readFileSync(taskFile, "utf8") };
  });
}

/** Register one subagent tool from the callable agent catalog snapshotted for this Pi session. */
export default function (pi: ExtensionAPI): void {
  registerDelegatedTaskInput(pi);

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
