/**
 * picker.ts — the `/subagents` command: a searchable list of this
 * conversation's children and grandchildren, opening or stopping one (§10).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  decodeKittyPrintable,
  fuzzyFilter,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import {
  conversationChildren,
  displayLabel,
  type InspectDeps,
  openFloat,
  type PickerChild,
  stopChild,
} from "./inspect.ts";
import type { TmuxExec } from "./tmux.ts";

export interface PickerDeps extends InspectDeps {
  /** The operator's server, where the float is shown. */
  outer: TmuxExec;
}

type Choice = { action: "open" | "stop"; childId: string };

const MAX_VISIBLE = 12;
const HELP = "Enter open   Ctrl+X stop   Up/Down navigate   Esc cancel";

export function rowLabel(child: PickerChild): string {
  const fields = [child.childId, child.agent, child.state];
  if (child.label !== undefined) fields.push(displayLabel(child.label));
  return `${child.nested ? "    " : ""}${fields.join("  ")}`;
}

export async function runSubagentsCommand(
  ctx: ExtensionCommandContext,
  deps: PickerDeps,
): Promise<void> {
  const pane = deps.env.TMUX_PANE;
  if (ctx.mode !== "tui" || !pane) {
    ctx.ui.notify("/subagents needs Pi's interactive TUI running inside tmux.", "error");
    return;
  }
  try {
    const rows = await conversationChildren(
      ctx.sessionManager.getSessionId(),
      deps,
      (childId, error) => ctx.ui.notify(`Skipped child ${childId}: ${error}`, "warning"),
    );
    if (rows.length === 0) {
      ctx.ui.notify("No subagents for this conversation", "info");
      return;
    }
    const choice = await pick(ctx, rows);
    if (choice?.action === "open") {
      await openFloat(choice.childId, pane, deps.outer, deps);
    } else if (choice?.action === "stop") {
      const confirmed = await ctx.ui.confirm(
        `Stop ${choice.childId}?`,
        "Work in progress is lost. Its transcript is kept, and it resumes when opened or asked again.",
      );
      if (!confirmed) return;
      const stopped = await stopChild(choice.childId, deps);
      ctx.ui.notify(stopped ? `Stopped ${choice.childId}` : `${choice.childId} is not running`);
    }
  } catch (error) {
    ctx.ui.notify(`Subagents: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function pick(ctx: ExtensionCommandContext, rows: PickerChild[]): Promise<Choice | undefined> {
  const items: SelectItem[] = rows.map((row) => ({ value: row.childId, label: rowLabel(row) }));
  return ctx.ui.custom<Choice | undefined>((tui, theme, _keybindings, done) => {
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
    const makeList = (shown: SelectItem[]) => {
      const created = new SelectList(shown, MAX_VISIBLE, listTheme);
      created.onSelect = (item) => done({ action: "open", childId: item.value });
      created.onCancel = () => done(undefined);
      return created;
    };

    let filter = "";
    let list = makeList(items);
    const listSlot = new Container();
    listSlot.addChild(list);
    const help = new Text(theme.fg("dim", HELP), 1, 0);

    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
    container.addChild(listSlot);
    container.addChild(help);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    // SelectList's own filter matches value prefixes only, so the list is rebuilt per filter.
    const setFilter = (next: string) => {
      filter = next;
      list = makeList(filter ? fuzzyFilter(items, filter, (item) => item.label) : items);
      listSlot.clear();
      listSlot.addChild(list);
      help.setText(theme.fg("dim", filter ? `Search: ${filter}   ${HELP}` : HELP));
      tui.requestRender();
    };

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "ctrl+x")) {
          const item = list.getSelectedItem();
          if (item) done({ action: "stop", childId: item.value });
          return;
        }
        if (matchesKey(data, "backspace")) {
          if (filter) setFilter(Array.from(filter).slice(0, -1).join(""));
          return;
        }
        // Any text without control characters, so labels in any script can be searched.
        const text = decodeKittyPrintable(data) ?? data;
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are keys, not text
        if (text && !/[\x00-\x1f\x7f]/.test(text)) {
          setFilter(filter + text);
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
