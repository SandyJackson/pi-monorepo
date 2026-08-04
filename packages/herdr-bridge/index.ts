/**
 * herdr-bridge — generic bridge from blocking tools to herdr:blocked events.
 *
 * Watches tool execution start/end for tools that block on user input and
 * emits `herdr:blocked` so herdr can show a "blocked" state in the tmux
 * status bar.
 *
 * ## Blocking tools
 *
 * Tools listed in BLOCKING_TOOLS are tracked. When one starts, herdr:blocked
 * with active:true is emitted. When it finishes, active:false is emitted.
 *
 * bash-permission has its own herdr integration and is NOT included here.
 *
 * ## Adding a tool
 *
 * Add the tool's name to BLOCKING_TOOLS. The tool must block on user input
 * (typically via ctx.ui.confirm() or ctx.ui.custom()) for the bridge to be
 * meaningful — otherwise herdr would show "blocked" for a tool that returns
 * immediately.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HERDR_BLOCKED_EVENT } from "@pi-workspace/herdr-contract";

/** Human-friendly label shown in herdr for each blocking tool. */
const LABELS: Record<string, string> = {
  ask_user_question: "Waiting for your answer",
};

const BLOCKING_TOOLS = new Set(Object.keys(LABELS));

/**
 * Return a human-friendly label for a blocking tool.
 * Falls back to the raw tool name if no label is registered.
 */
function toolLabel(toolName: string): string {
  return LABELS[toolName] ?? `Waiting for: ${toolName}`;
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_execution_start", (event, _ctx: ExtensionContext) => {
    if (BLOCKING_TOOLS.has(event.toolName)) {
      pi.events.emit(HERDR_BLOCKED_EVENT, {
        active: true,
        label: toolLabel(event.toolName),
      });
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (BLOCKING_TOOLS.has(event.toolName)) {
      pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
    }
  });
}
