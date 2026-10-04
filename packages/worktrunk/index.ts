import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import {
  type BusyAction,
  buildWorktreeRows,
  createWtExecutor,
  errorMessage,
  findUndeliveredRelocation,
  prepareTargetSession,
  RELOCATION_CUSTOM_TYPE,
  type RelocatedSession,
  type RelocationRecord,
  renderRelocationEntry,
  runWorktreePicker,
  type SwitchExecutor,
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

/** Ask whether to wait for or abort a running agent before switching. */
async function chooseBusyAction(ctx: ExtensionCommandContext): Promise<BusyAction | null> {
  const choice = await ctx.ui.select("The agent is still running", [
    "Wait for the current run to finish",
    "Abort and switch",
  ]);
  if (choice === undefined) return null;
  return choice === "Abort and switch" ? "abort" : "wait";
}

type LoaderOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Run one step behind a loader that shows no cancel affordance: Worktrunk's
 * hooks are the transaction, so the switch must run to completion.
 */
async function runWithLoader<T>(
  ctx: ExtensionCommandContext,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  const outcome = await ctx.ui.custom<LoaderOutcome<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, label, { cancellable: false });
    void run().then(
      (value) => done({ ok: true, value }),
      (error) => done({ ok: false, error }),
    );
    return loader;
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Adapt `ctx` to the relocation boundary used by `runWorktreePicker`. */
function createSwitchExecutor(ctx: ExtensionCommandContext): SwitchExecutor {
  return {
    isBusy: () => !ctx.isIdle(),
    abort: () => ctx.abort(),
    waitForIdle: () => ctx.waitForIdle(),
    prepare: (targetPath, record) => prepareTargetSession(ctx.sessionManager, targetPath, record),
    switch: (sessionFile, withSession) =>
      ctx.switchSession(sessionFile, {
        withSession: (replaced) =>
          withSession({
            notify: (message, type) => replaced.ui.notify(message, type),
          } satisfies RelocatedSession),
      }),
  };
}

/** Register `/wt` against an injected Worktrunk CLI executor. */
export function registerWorktrunk(pi: ExtensionAPI, executor: WtExecutor): void {
  let switchInProgress = false;
  pi.registerCommand("wt", {
    description: "Pick a Worktrunk worktree for this session",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/wt requires the interactive TUI.", "warning");
        return;
      }
      if (switchInProgress) {
        ctx.ui.notify("A worktree switch is already in progress.", "warning");
        return;
      }
      switchInProgress = true;
      try {
        await runWorktreePicker(executor, createSwitchExecutor(ctx), {
          cwd: ctx.cwd,
          notify: (message, type) => ctx.ui.notify(message, type),
          selectWorktree: (worktrees) => pickWorktree(ctx, worktrees),
          withLoader: (label, run) => runWithLoader(ctx, label, run),
          chooseBusyAction: () => chooseBusyAction(ctx),
          confirmDirty: (branch) =>
            ctx.ui.confirm(
              "Uncommitted changes",
              `${branch} has uncommitted changes. Switch anyway? Your changes stay in the current worktree.`,
            ),
        });
      } finally {
        switchInProgress = false;
      }
    },
  });

  // The relocation record persisted into the target session is the durable
  // transcript entry; custom entries never enter the LLM context.
  pi.registerEntryRenderer<RelocationRecord>(RELOCATION_CUSTOM_TYPE, renderRelocationEntry);

  // Queue the LLM-facing relocation note on the runtime that owns the target
  // session. It rides the nextTurn queue, so it is delivered with the next
  // prompt after that prompt's compaction check, without starting a turn.
  pi.on("session_start", async (event, ctx) => {
    // A reload reuses the same AgentSession, which still holds any undelivered
    // nextTurn message; re-enqueueing here would duplicate it.
    if (event.reason === "reload") return;

    const pending = findUndeliveredRelocation(ctx.sessionManager.getBranch(), ctx.cwd);
    if (!pending) return;

    try {
      // Hidden copy for the model only; the visible one is the persisted record.
      // details keys the delivery so later session starts do not re-queue an
      // already delivered note. Async failures surface via the extension error
      // listener, not here.
      pi.sendMessage(
        {
          customType: RELOCATION_CUSTOM_TYPE,
          content: pending.note,
          display: false,
          details: { relocationId: pending.relocationId },
        },
        { deliverAs: "nextTurn" },
      );
    } catch (error) {
      // Only synchronous failures land here; do not promise a retry on a later
      // session start (a reload reuses the same runtime and its queue).
      ctx.ui.notify(
        `Moved here, but the relocation notice could not be queued; the relocation record is saved and can be retried on resume: ${errorMessage(error)}`,
        "error",
      );
    }
  });
}

export default function (pi: ExtensionAPI): void {
  registerWorktrunk(pi, createWtExecutor());
}
