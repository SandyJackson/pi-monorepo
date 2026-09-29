import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import {
  buildWorktreeRows,
  createWtExecutor,
  runWorktreePicker,
  type Worktree,
  type WtExecutor,
} from "./worktrunk.ts";

/** Open the worktree picker and resolve to the chosen worktree, or null on cancel. */
async function pickWorktree(
  ctx: ExtensionCommandContext,
  worktrees: readonly Worktree[],
): Promise<Worktree | null> {
  return ctx.ui.custom<Worktree | null>((tui, theme, _keybindings, done) => {
    const byPath = new Map(worktrees.map((worktree) => [worktree.path, worktree]));
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Worktrunk worktrees")), 1, 0));

    const rows = buildWorktreeRows(worktrees, theme);
    const selectList = new SelectList(rows, Math.min(rows.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    selectList.onSelect = (item) => done(byPath.get(item.value) ?? null);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** Register `/wt` against an injected Worktrunk CLI executor. */
export function registerWorktrunk(pi: ExtensionAPI, executor: WtExecutor): void {
  pi.registerCommand("wt", {
    description: "Pick a Worktrunk worktree for this session",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/wt requires the interactive TUI.", "warning");
        return;
      }
      await runWorktreePicker(executor, {
        cwd: ctx.cwd,
        notify: (message, type) => ctx.ui.notify(message, type),
        selectWorktree: (worktrees) => pickWorktree(ctx, worktrees),
      });
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerWorktrunk(pi, createWtExecutor());
}
