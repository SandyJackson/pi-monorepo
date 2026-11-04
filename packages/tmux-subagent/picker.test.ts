import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READY_MS } from "./launch.ts";
import { runSubagentsCommand } from "./picker.ts";
import { type ChildRecord, createStore, type NewChild, type Store } from "./store.ts";
import { createFakeTmux } from "./test-support.ts";
import type { TmuxExec } from "./tmux.ts";

const SESSION = "parent-session";
const KEY = { enter: "\r", escape: "\x1b", down: "\x1b[B", ctrlX: "\x18", backspace: "\x7f" };

let root: string;
let worktree: string;
let store: Store;
let privateTmux: ReturnType<typeof createFakeTmux>;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-picker-")));
  worktree = path.join(root, "repo");
  fs.mkdirSync(worktree);
  store = createStore(path.join(root, "state"));
  privateTmux = createFakeTmux();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function addChild(overrides: Partial<NewChild> = {}): ChildRecord {
  // Distinct creation times, so listing order is deterministic.
  const before = Date.now();
  while (Date.now() === before) {}
  return store.createChild(
    {
      parent: { sessionId: SESSION },
      worktree,
      cwd: worktree,
      agent: { name: "scout", source: "user" },
      projectTrust: false,
      depth: 1,
      piCommand: ["/node", "/pi/cli.js"],
      ...overrides,
    },
    "",
  );
}

/** Give a child a live, ready session on the scripted private server. */
function liven(child: ChildRecord, state: "idle" | "running" = "idle"): void {
  privateTmux.sessions.set(`sa-${child.childId}`, {
    name: `sa-${child.childId}`,
    cwd: child.cwd,
    env: { PI_SUBAGENT_NONCE: "n1" },
    command: [],
  });
  store.writeStatus(child.childId, { version: 1, nonce: "n1", pid: 1, state });
}

/** The operator's server: records commands; `respond` can script a result. */
function createFakeOuter(respond?: (args: readonly string[]) => Awaited<ReturnType<TmuxExec>>) {
  const calls: string[][] = [];
  const exec: TmuxExec = async (args) => {
    calls.push([...args]);
    return respond?.(args) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

/**
 * Run `/subagents`, pressing `keys` in the picker. Records what the picker
 * showed before any key, every notification, and each confirmation asked.
 */
async function run(
  keys: string[],
  options: {
    mode?: string;
    env?: NodeJS.ProcessEnv;
    confirm?: boolean;
    outer?: ReturnType<typeof createFakeOuter>;
  } = {},
) {
  const outer = options.outer ?? createFakeOuter();
  const notices: Array<{ message: string; type?: string }> = [];
  const confirms: string[] = [];
  let shown: string[] | undefined;
  const ctx = {
    mode: options.mode ?? "tui",
    sessionManager: { getSessionId: () => SESSION },
    ui: {
      notify: (message: string, type?: string) => notices.push({ message, type }),
      confirm: async (title: string) => {
        confirms.push(title);
        return options.confirm ?? true;
      },
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => { render(width: number): string[]; handleInput(data: string): void },
      ) =>
        new Promise((resolve) => {
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          shown = component.render(120);
          for (const key of keys) component.handleInput(key);
        }),
    },
  } as unknown as ExtensionCommandContext;

  await runSubagentsCommand(ctx, {
    store,
    tmux: privateTmux.exec,
    outer: outer.exec,
    socket: "pi-subagents-test",
    env: options.env ?? { TMUX_PANE: "%3" },
  });
  return { notices, confirms, shown: shown?.join("\n"), outer };
}

function attachArgs(childId: string) {
  return [
    "new-pane",
    "-O",
    "-D",
    "-x",
    "90%",
    "-y",
    "90%",
    "-t",
    "%3",
    "--",
    "env",
    "-u",
    "TMUX",
    "-u",
    "TMUX_PANE",
    "tmux",
    "-L",
    "pi-subagents-test",
    "attach",
    "-t",
    `=sa-${childId}`,
  ];
}

describe("/subagents", () => {
  it.each([
    ["outside tmux", { env: {} }],
    ["outside the TUI", { mode: "rpc" }],
  ])("shows an error and nothing else %s", async (_case, options) => {
    addChild();

    const result = await run([], options);

    expect(result.shown).toBeUndefined();
    expect(result.notices).toEqual([
      { message: "/subagents needs Pi's interactive TUI running inside tmux.", type: "error" },
    ]);
    expect(privateTmux.calls).toEqual([]);
  });

  it("lists this conversation's children with their children nested, and no others", async () => {
    const first = addChild({ label: "issue #12" });
    const grandchild = addChild({
      parent: { sessionId: first.childId },
      depth: 2,
      agent: { name: "reviewer", source: "user" },
    });
    const second = addChild();
    const otherParent = addChild({ parent: { sessionId: "another-session" } });
    const otherGrandchild = addChild({ parent: { sessionId: otherParent.childId }, depth: 2 });
    liven(first, "running");

    const result = await run([KEY.escape]);

    const rows = (result.shown ?? "")
      .split("\n")
      .filter((line) => line.includes("scout-") || line.includes("reviewer-"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(`${first.childId}  scout  running  issue #12`);
    expect(rows[1]).toContain(`    ${grandchild.childId}  reviewer  stopped`);
    expect(rows[2]).toContain(`${second.childId}  scout  stopped`);
    expect(result.shown).not.toContain(otherParent.childId);
    expect(result.shown).not.toContain(otherGrandchild.childId);
    expect(result.outer.calls).toEqual([]);
  });

  it("says so when the conversation has no subagents", async () => {
    addChild({ parent: { sessionId: "another-session" } });

    const result = await run([]);

    expect(result.shown).toBeUndefined();
    expect(result.notices).toEqual([
      { message: "No subagents for this conversation", type: "info" },
    ]);
  });

  it("names an unreadable child and lists the rest", async () => {
    const child = addChild();
    fs.mkdirSync(path.join(store.root, "children", "scout-abcd"), { recursive: true });

    const result = await run([KEY.escape]);

    expect(result.shown).toContain(child.childId);
    expect(result.notices[0]).toMatchObject({ type: "warning" });
    expect(result.notices[0].message).toMatch(/^Skipped child scout-abcd: /);
  });

  it("resumes a stopped child on Enter, then floats an attach client over Pi's pane, keeping drain", async () => {
    const child = addChild();
    const drain = path.join(store.childDir(child.childId), "drain");
    fs.writeFileSync(drain, "");
    privateTmux = createFakeTmux({
      onNewSession: (session) =>
        store.writeStatus(child.childId, {
          version: 1,
          nonce: session.env.PI_SUBAGENT_NONCE,
          pid: 1,
          state: "idle",
        }),
    });

    const result = await run([KEY.enter]);

    expect(privateTmux.launches).toBe(1);
    expect(result.outer.calls).toEqual([attachArgs(child.childId)]);
    expect(fs.existsSync(drain)).toBe(true);
    expect(result.notices).toEqual([]);
  });

  it("searches rows by text and opens the match", async () => {
    addChild();
    const reviewer = addChild({ agent: { name: "reviewer", source: "user" } });
    liven(reviewer);

    const result = await run(["r", "e", "v", "x", KEY.backspace, KEY.enter]);

    expect(privateTmux.launches).toBe(0);
    expect(result.outer.calls).toEqual([attachArgs(reviewer.childId)]);
  });

  it("searches labels in any script", async () => {
    addChild({ label: "issue #12" });
    const fix = addChild({ label: "修复登录" });
    liven(fix);

    const result = await run(["修", "复", "x", KEY.backspace, KEY.enter]);

    expect(result.outer.calls).toEqual([attachArgs(fix.childId)]);
  });

  it("stops the selected child with Ctrl+X once confirmed, keeping its records", async () => {
    const first = addChild();
    const second = addChild();
    liven(first);
    liven(second);

    const result = await run([KEY.down, KEY.ctrlX]);

    expect(result.confirms).toEqual([`Stop ${second.childId}?`]);
    expect([...privateTmux.sessions.keys()]).toEqual([`sa-${first.childId}`]);
    expect(store.readChild(second.childId).childId).toBe(second.childId);
    expect(result.notices).toEqual([{ message: `Stopped ${second.childId}`, type: undefined }]);
    expect(result.outer.calls).toEqual([]);
  });

  it("stops nothing when the stop is not confirmed", async () => {
    const child = addChild();
    liven(child);

    const result = await run([KEY.ctrlX], { confirm: false });

    expect([...privateTmux.sessions.keys()]).toEqual([`sa-${child.childId}`]);
    expect(result.notices).toEqual([]);
  });

  it("rejects a different socket before starting or attaching a child", async () => {
    addChild();
    store.bindSocket("parent-socket");

    const result = await run([KEY.enter]);

    expect(result.notices[0].type).toBe("error");
    expect(result.notices[0].message).toMatch(/parent-socket.*pi-subagents-test/);
    expect(privateTmux.launches).toBe(0);
    expect(result.outer.calls).toEqual([]);
  });

  it("shows tmux's refusal when the window already has a float", async () => {
    const child = addChild();
    liven(child);
    const outer = createFakeOuter(() => ({
      code: 1,
      stdout: "",
      stderr: "window already has a modal pane\n",
    }));

    const result = await run([KEY.enter], { outer });

    expect(outer.calls).toEqual([attachArgs(child.childId)]);
    expect(result.notices).toEqual([
      {
        message: "Subagents: tmux could not open the float: window already has a modal pane",
        type: "error",
      },
    ]);
  });

  it("shows the launch failure and opens no float when the child cannot be resumed", async () => {
    const gone = path.join(root, "gone");
    fs.mkdirSync(gone);
    addChild({ cwd: gone });
    fs.rmdirSync(gone);

    const result = await run([KEY.enter]);

    expect(privateTmux.launches).toBe(0);
    expect(result.outer.calls).toEqual([]);
    expect(result.notices[0].message).toContain("is not an existing directory");
  });

  it("still floats a live child that has not reported readiness, so the operator can see why", async () => {
    const child = addChild();
    privateTmux.sessions.set(`sa-${child.childId}`, {
      name: `sa-${child.childId}`,
      cwd: child.cwd,
      env: { PI_SUBAGENT_NONCE: "n1" },
      command: [],
    });
    vi.useFakeTimers();
    try {
      const pending = run([KEY.enter]);
      await vi.advanceTimersByTimeAsync(READY_MS + 1000);
      const result = await pending;

      expect(result.outer.calls).toEqual([attachArgs(child.childId)]);
    } finally {
      vi.useRealTimers();
    }
  });
});
