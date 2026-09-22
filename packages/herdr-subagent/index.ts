import * as fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { discoverProjectAgents, discoverUserAgents, mergeAgentLists } from "./agents.ts";
import { executeHerdrDelegation, herdrDelegationEnvironment } from "./herdr/delegation.ts";
import { DELEGATED_TASK_FILE_FLAG, DELEGATED_TASK_PLACEHOLDER } from "./herdr/session.ts";
import { createSubagentTool } from "./subagent-tool.ts";

function registerDelegatedTaskInput(pi: ExtensionAPI): void {
  pi.registerFlag(DELEGATED_TASK_FILE_FLAG, {
    description: "Internal path to a delegated-task prompt",
    type: "string",
  });

  let taskPending = true;

  pi.on("input", (event) => {
    if (
      !taskPending ||
      event.source !== "interactive" ||
      event.text !== DELEGATED_TASK_PLACEHOLDER
    ) {
      return { action: "continue" };
    }
    // Pi applies CLI flag values after loading extension factories.
    const taskFile = pi.getFlag(DELEGATED_TASK_FILE_FLAG);
    if (typeof taskFile !== "string") return { action: "continue" };
    const task = fs.readFileSync(taskFile, "utf8");
    taskPending = false;
    return { action: "transform", text: task };
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
