import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWtExecutor, runWorktreeList, type WtExecutor } from "./worktrunk.ts";

/** Register `/wt` against an injected Worktrunk CLI executor. */
export function registerWorktrunk(pi: ExtensionAPI, executor: WtExecutor): void {
  pi.registerCommand("wt", {
    description: "List this repository's Worktrunk worktrees",
    handler: async (_args, ctx) => {
      await runWorktreeList(executor, {
        cwd: ctx.cwd,
        notify: (message, type) => ctx.ui.notify(message, type),
      });
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerWorktrunk(pi, createWtExecutor());
}
