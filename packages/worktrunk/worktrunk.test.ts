import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type CustomEntry,
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorktrunk } from "./index.ts";
import {
  buildWorktreeRows,
  findUndeliveredRelocation,
  type PickerColor,
  parseWorktreeList,
  parseWorktreeSwitch,
  prepareTargetSession,
  RELOCATION_CUSTOM_TYPE,
  type RelocatedSession,
  type RelocationDelivery,
  type RelocationRecord,
  renderRelocationEntry,
  runWorktreePicker,
  type SwitchExecutor,
  type Worktree,
  type WorktrunkUi,
  type WtExecutor,
  type WtResult,
} from "./worktrunk.ts";

const SCHEMA_2_LIST = JSON.stringify({
  schema: 2,
  repo: {
    default_branch: "main",
    forge: {
      url: "https://github.com/org/repo",
      provider: "github",
      host: "github.com",
      owner: "org",
      name: "repo",
      remote: "origin",
    },
  },
  collected: { ci: false, summary: false },
  items: [
    {
      branch: "feature-api",
      head: { sha: "aaa", short_sha: "aaa", subject: "Add API tests" },
      worktree: {
        path: "/repo.feature-api",
        main: false,
        current: true,
        previous: false,
        detached: false,
        changes: {
          staged: true,
          modified: true,
          untracked: false,
          renamed: false,
          deleted: false,
          conflicted: false,
          diff: { added: 54, deleted: 5 },
        },
      },
      default_branch: { ahead: 4, behind: 1 },
      upstream: { remote: "origin", branch: "feature-api", ahead: 3, behind: 0 },
      marker: "🤖",
      display: {
        state: "diverged",
        symbols: "+!↕",
        statusline: "\u001b[36mfeature-api\u001b[39m ..",
      },
    },
    {
      branch: "main",
      head: { sha: "bbb", short_sha: "bbb", subject: "Merge fix-auth" },
      worktree: {
        path: "/repo",
        main: true,
        current: false,
        previous: true,
        detached: false,
        changes: null,
      },
      display: { symbols: "", statusline: "main" },
    },
  ],
});

const TARGET_PATH = "/repo.target";

let tempDir: string;
let sessionDir: string;

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktrunk-test-")));
  sessionDir = path.join(tempDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function scriptedExecutor(result: WtResult): {
  executor: WtExecutor;
  calls: Array<{ args: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  return {
    calls,
    executor: async (args, cwd) => {
      calls.push({ args, cwd });
      return result;
    },
  };
}

/** Same as `scriptedExecutor`, but answers `wt list` and `wt switch` separately. */
function commandExecutor(switchResult: WtResult): {
  executor: WtExecutor;
  calls: Array<{ args: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  return {
    calls,
    executor: async (args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === "list") return { exitCode: 0, stdout: SCHEMA_2_LIST, stderr: "" };
      return switchResult;
    },
  };
}

interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

interface SwitchRecord {
  file: string;
  notifications: Notification[];
}

interface SentMessage {
  message: {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  };
  options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

/** ExtensionAPI seam that records the registrations `registerWorktrunk` makes. */
function fakePi(overrides?: { sendMessageError?: Error }): {
  pi: ExtensionAPI;
  commands: string[];
  entryRenderers: Array<{ customType: string; renderer: unknown }>;
  sessionStartHandlers: Array<(event: unknown, ctx: unknown) => Promise<void> | void>;
  sentMessages: SentMessage[];
} {
  const commands: string[] = [];
  const entryRenderers: Array<{ customType: string; renderer: unknown }> = [];
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => Promise<void> | void> = [];
  const sentMessages: SentMessage[] = [];
  const pi = {
    registerCommand: (name: string) => {
      commands.push(name);
    },
    registerEntryRenderer: (customType: string, renderer: unknown) => {
      entryRenderers.push({ customType, renderer });
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      if (event === "session_start") sessionStartHandlers.push(handler);
    },
    sendMessage: (message: SentMessage["message"], options: SentMessage["options"]) => {
      if (overrides?.sendMessageError) throw overrides.sendMessageError;
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, entryRenderers, sessionStartHandlers, sentMessages };
}

/** ExtensionContext seam for a session_start dispatch. */
function sessionStartContext(
  cwd: string,
  sessionManager: unknown,
  notifications: Notification[],
): unknown {
  return {
    cwd,
    mode: "tui",
    sessionManager,
    ui: {
      notify: (message: string, type: Notification["type"]) => {
        notifications.push({ message, type });
      },
    },
  };
}

async function dispatchSessionStart(
  handler: (event: unknown, ctx: unknown) => Promise<void> | void,
  reason: string,
  cwd: string,
  sessionManager: unknown,
): Promise<Notification[]> {
  const notifications: Notification[] = [];
  await handler(
    { type: "session_start", reason },
    sessionStartContext(cwd, sessionManager, notifications),
  );
  return notifications;
}

function captureUi(choose: (worktrees: Worktree[]) => Worktree | null, cwd = "/repo") {
  const notifications: Notification[] = [];
  const selections: Worktree[][] = [];
  const loaders: string[] = [];
  const ui: WorktrunkUi = {
    cwd,
    notify: (message, type) => notifications.push({ message, type }),
    selectWorktree: async (worktrees) => {
      selections.push([...worktrees]);
      return choose([...worktrees]);
    },
    withLoader: async (label, run) => {
      loaders.push(label);
      return run();
    },
  };
  return { notifications, selections, loaders, ui };
}

interface FakeSwitch {
  executor: SwitchExecutor;
  preparedPaths: string[];
  switches: SwitchRecord[];
  events: string[];
}

function fakeSwitchExecutor(overrides?: {
  prepared?: string;
  prepareFn?: (targetPath: string, record: RelocationRecord) => string;
  prepareError?: Error;
  switchError?: Error;
}): FakeSwitch {
  const preparedPaths: string[] = [];
  const switches: SwitchRecord[] = [];
  const events: string[] = [];
  return {
    preparedPaths,
    switches,
    events,
    executor: {
      waitForIdle: async () => {
        events.push("waitForIdle");
      },
      prepare: (targetPath, record) => {
        events.push("prepare");
        preparedPaths.push(targetPath);
        if (overrides?.prepareFn) return overrides.prepareFn(targetPath, record);
        if (overrides?.prepareError) throw overrides.prepareError;
        return overrides?.prepared ?? path.join(sessionDir, "prepared.jsonl");
      },
      switch: async (file, withSession) => {
        events.push("switch");
        if (overrides?.switchError) throw overrides.switchError;
        const record: SwitchRecord = { file, notifications: [] };
        const session: RelocatedSession = {
          notify: (message, type) => record.notifications.push({ message, type }),
        };
        await withSession(session);
        switches.push(record);
        return { cancelled: false };
      },
    },
  };
}

function recordingTheme() {
  const calls: Array<{ color: PickerColor; text: string }> = [];
  return {
    calls,
    theme: {
      fg: (color: PickerColor, text: string) => {
        calls.push({ color, text });
        return text;
      },
    },
  };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "api",
    provider: "provider",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

/** Write a two-turn source session and return its manager and file. */
function writeSourceSession(cwd: string): {
  manager: SessionManager;
  file: string;
  firstUser: string;
} {
  const manager = SessionManager.create(cwd, sessionDir);
  const firstUser = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  manager.appendMessage(assistantMessage("first reply"));
  manager.appendMessage({ role: "user", content: "second", timestamp: 3 });
  manager.appendMessage(assistantMessage("second reply"));
  const file = manager.getSessionFile();
  if (!file) throw new Error("source session was not persisted");
  return { manager, file, firstUser };
}

describe("parseWorktreeList", () => {
  it("maps schema-2 worktree rows into branch, flags, changes and marker", () => {
    expect(parseWorktreeList(SCHEMA_2_LIST)).toEqual([
      {
        branch: "feature-api",
        path: "/repo.feature-api",
        main: false,
        current: true,
        previous: false,
        detached: false,
        marker: "🤖",
        changes: {
          staged: true,
          modified: true,
          untracked: false,
          renamed: false,
          deleted: false,
          conflicted: false,
          diff: { added: 54, deleted: 5 },
        },
      },
      {
        branch: "main",
        path: "/repo",
        main: true,
        current: false,
        previous: true,
        detached: false,
        marker: null,
        changes: null,
      },
    ]);
  });

  it("keeps a detached worktree whose branch is null", () => {
    const stdout = JSON.stringify({
      schema: 2,
      items: [
        {
          branch: null,
          worktree: { path: "/repo.detached", detached: true, changes: null },
        },
      ],
    });

    expect(parseWorktreeList(stdout)).toEqual([
      {
        branch: null,
        path: "/repo.detached",
        main: false,
        current: false,
        previous: false,
        detached: true,
        marker: null,
        changes: null,
      },
    ]);
  });

  it("ignores branch-only rows that have no worktree object", () => {
    const stdout = JSON.stringify({
      schema: 2,
      items: [
        { branch: "main", worktree: { path: "/repo", main: true, changes: null } },
        { branch: "remote-only" },
      ],
    });

    expect(parseWorktreeList(stdout).map((worktree) => worktree.branch)).toEqual(["main"]);
  });

  it("rejects a schema-1 bare array", () => {
    expect(() => parseWorktreeList(JSON.stringify([{ branch: "main" }]))).toThrow(/schema/i);
  });

  it("rejects a non-object envelope", () => {
    expect(() => parseWorktreeList("null")).toThrow(/schema/i);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseWorktreeList("not json")).toThrow(/JSON/i);
  });
});

describe("parseWorktreeSwitch", () => {
  it("reads the target path from switch JSON", () => {
    expect(
      parseWorktreeSwitch(
        JSON.stringify({ action: "created", branch: "feature", path: TARGET_PATH }),
      ),
    ).toBe(TARGET_PATH);
  });

  it("rejects output without a path", () => {
    expect(() => parseWorktreeSwitch(JSON.stringify({ action: "existing" }))).toThrow(/path/i);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseWorktreeSwitch("not json")).toThrow(/JSON/i);
  });
});

function relocationRecord(targetCwd: string, branch = "main"): RelocationRecord {
  return {
    branch,
    sourcePath: path.join(tempDir, "source"),
    targetPath: targetCwd,
    note: relocationNoteFor(targetCwd, branch),
  };
}

function relocationNoteFor(targetCwd: string, branch: string): string {
  return [
    `Worktree relocation: this session moved from ${path.join(tempDir, "source")} to ${targetCwd} (branch ${branch}).`,
    `Your working directory is now ${targetCwd}.`,
    "Absolute paths from earlier in this conversation belong to the previous checkout: do not reuse them and do not cd back.",
  ].join(" ");
}

describe("prepareTargetSession", () => {
  it("forks the persisted session, appends the relocation record and keeps the carried branch", () => {
    const { file, manager } = writeSourceSession(path.join(tempDir, "source"));
    const target = path.join(tempDir, "target");

    const prepared = prepareTargetSession(manager, target, relocationRecord(target), sessionDir);

    expect(prepared).not.toBe(file);
    const reopened = SessionManager.open(prepared);
    expect(reopened.getCwd()).toBe(target);
    const leaf = reopened.getLeafEntry();
    expect(leaf?.type).toBe("custom");
    if (leaf?.type !== "custom") throw new Error("leaf is not the relocation record");
    expect(leaf.customType).toBe(RELOCATION_CUSTOM_TYPE);
    expect(leaf.parentId).toBe(manager.getLeafId());
    expect(leaf.data).toEqual(relocationRecord(target));
    expect(reopened.getEntries()).toHaveLength(5);
    expect(reopened.getHeader()?.parentSession).toBe(file);
  });

  it("excludes the relocation record from the model context while keeping it in the file", () => {
    const { manager } = writeSourceSession(path.join(tempDir, "source"));
    const target = path.join(tempDir, "target");

    const prepared = prepareTargetSession(manager, target, relocationRecord(target), sessionDir);

    const reopened = SessionManager.open(prepared);
    const context = reopened.buildSessionContext();
    expect(context.messages).toHaveLength(4);
    for (const message of context.messages) {
      expect(JSON.stringify(message)).not.toContain(RELOCATION_CUSTOM_TYPE);
    }
    expect(reopened.getEntries()).toHaveLength(5);
  });

  it("appends the relocation record to a header-only target session for an empty conversation", () => {
    const manager = SessionManager.create(path.join(tempDir, "source"), sessionDir);
    const target = path.join(tempDir, "target");

    const prepared = prepareTargetSession(manager, target, relocationRecord(target), sessionDir);

    const reopened = SessionManager.open(prepared);
    expect(reopened.getCwd()).toBe(target);
    const leaf = reopened.getLeafEntry();
    expect(leaf?.type).toBe("custom");
    if (leaf?.type !== "custom") throw new Error("leaf is not the relocation record");
    expect(leaf.customType).toBe(RELOCATION_CUSTOM_TYPE);
    expect(leaf.parentId).toBeNull();
    expect(leaf.data).toEqual(relocationRecord(target));
    // The header-only session is already flushed: the record is on disk.
    expect(fs.readFileSync(prepared, "utf8").split("\n")).toHaveLength(3);
  });

  it("copies the active branch and appends the relocation record when the leaf drifted", () => {
    const { file, firstUser } = writeSourceSession(path.join(tempDir, "source"));
    const target = path.join(tempDir, "target");
    const persisted = SessionManager.open(file);
    persisted.branch(firstUser);

    const prepared = prepareTargetSession(persisted, target, relocationRecord(target), sessionDir);

    const reopened = SessionManager.open(prepared);
    expect(reopened.getCwd()).toBe(target);
    const leaf = reopened.getLeafEntry();
    expect(leaf?.type).toBe("custom");
    if (leaf?.type !== "custom") throw new Error("leaf is not the relocation record");
    expect(leaf.parentId).toBe(firstUser);
    expect(leaf.data).toEqual(relocationRecord(target));
    expect(reopened.getEntries()[0]?.id).toBe(firstUser);
    expect(reopened.getEntries()).toHaveLength(2);
  });

  it("creates a fresh target session with the relocation record for an ephemeral conversation", () => {
    const manager = SessionManager.inMemory(path.join(tempDir, "source"));
    manager.appendMessage({ role: "user", content: "ephemeral", timestamp: 1 });
    const target = path.join(tempDir, "target");

    const prepared = prepareTargetSession(manager, target, relocationRecord(target), sessionDir);

    const reopened = SessionManager.open(prepared);
    expect(reopened.getCwd()).toBe(target);
    expect(reopened.getEntries()).toHaveLength(1);
    expect(reopened.getEntries()[0]?.type).toBe("custom");
    expect(reopened.getEntries()[0]?.data).toEqual(relocationRecord(target));
  });

  it("fails verification and leaves both sessions intact when the record's target cwd disagrees", () => {
    const { file, manager } = writeSourceSession(path.join(tempDir, "source"));
    const target = path.join(tempDir, "target");
    const sourceBefore = fs.readFileSync(file, "utf8");

    expect(() =>
      prepareTargetSession(
        manager,
        target,
        { ...relocationRecord(target), targetPath: path.join(tempDir, "other") },
        sessionDir,
      ),
    ).toThrow(/does not match/);

    expect(fs.readFileSync(file, "utf8")).toBe(sourceBefore);
  });
});

describe("buildWorktreeRows", () => {
  it("renders branch, flags, activity marker and change counts with theme colors", () => {
    const worktrees = parseWorktreeList(SCHEMA_2_LIST);
    const { theme, calls } = recordingTheme();

    const rows = buildWorktreeRows(worktrees, theme);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.value).toBe("/repo.feature-api");
    expect(rows[0]?.label).toContain("feature-api");
    expect(rows[0]?.label).toContain("🤖");
    expect(rows[0]?.description).toContain("current");
    expect(rows[0]?.description).toContain("+54 -5");
    expect(rows[1]?.description).toContain("previous");
    expect(calls).toContainEqual({ color: "accent", text: "🤖" });
    expect(calls).toContainEqual({ color: "success", text: "+54" });
    expect(calls).toContainEqual({ color: "error", text: "-5" });
    expect(calls).toContainEqual({ color: "success", text: "current" });
    expect(calls).toContainEqual({ color: "warning", text: "previous" });
  });

  it("renders dirty change markers with theme colors", () => {
    const worktrees = parseWorktreeList(SCHEMA_2_LIST);
    const { theme, calls } = recordingTheme();

    buildWorktreeRows(worktrees, theme);

    expect(calls).toContainEqual({ color: "success", text: "+" });
    expect(calls).toContainEqual({ color: "warning", text: "!" });
  });

  it("shows a detached worktree as a dimmed placeholder", () => {
    const worktrees = parseWorktreeList(
      JSON.stringify({
        schema: 2,
        items: [
          {
            branch: null,
            worktree: { path: "/repo.detached", detached: true, changes: null },
          },
        ],
      }),
    );
    const { theme, calls } = recordingTheme();

    const [row] = buildWorktreeRows(worktrees, theme);

    expect(row?.label).toContain("(detached)");
    expect(calls).toContainEqual({ color: "dim", text: "(detached)" });
  });

  it("never passes Worktrunk's ANSI statusline through", () => {
    const { theme } = recordingTheme();
    const rows = buildWorktreeRows(parseWorktreeList(SCHEMA_2_LIST), theme);

    const rendered = rows.map((row) => `${row.label} ${row.description}`).join(" ");
    expect(rendered).not.toContain("\u001b");
  });
});

describe("runWorktreePicker relocation", () => {
  function switchOutput(targetPath: string, branch = "main"): WtResult {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ action: "existing", branch, path: targetPath }),
      stderr: "",
    };
  }

  it("runs wt switch under a loader, prepares the returned path and moves the session", async () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "target-")));
    const { executor, calls } = commandExecutor(switchOutput(target));
    const chooseMain = (choices: Worktree[]) =>
      choices.find((worktree) => worktree.branch === "main") ?? null;
    const { ui, notifications, loaders } = captureUi(chooseMain);
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(calls).toEqual([
      { args: ["list", "--format=json"], cwd: "/repo" },
      { args: ["switch", "main", "--no-cd", "--format=json"], cwd: "/repo" },
    ]);
    expect(loaders).toHaveLength(1);
    expect(loaders[0]).toMatch(/main/);
    expect(switchExecutor.preparedPaths).toEqual([target]);
    expect(switchExecutor.switches).toHaveLength(1);
    expect(switchExecutor.switches[0]?.file).toBe(path.join(sessionDir, "prepared.jsonl"));
    expect(switchExecutor.switches[0]?.notifications).toHaveLength(1);
    expect(switchExecutor.switches[0]?.notifications[0]?.type).toBe("info");
    expect(switchExecutor.switches[0]?.notifications[0]?.message).toContain(target);
    expect(notifications).toEqual([]);
  });

  it("waits for the agent to be idle before it prepares or replaces the session", async () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "target-")));
    const { executor } = commandExecutor(switchOutput(target));
    const { ui } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(switchExecutor.events).toEqual(["waitForIdle", "prepare", "switch"]);
  });

  it("does not send anything through the replacement session; the note is queued by session_start", async () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "target-")));
    const { executor } = commandExecutor(switchOutput(target));
    const { ui } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(switchExecutor.switches).toHaveLength(1);
    expect(switchExecutor.switches[0]?.notifications).toHaveLength(1);
  });

  it("reports a failed wt switch verbatim and leaves the session untouched", async () => {
    const { executor } = commandExecutor({
      exitCode: 1,
      stdout: "switch stdout",
      stderr: "hook failed",
    });
    const { ui, notifications, loaders } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(loaders).toHaveLength(1);
    expect(switchExecutor.preparedPaths).toEqual([]);
    expect(switchExecutor.switches).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("hook failed");
    expect(notifications[0]?.message).toContain("switch stdout");
  });

  it("reports malformed switch output and leaves the session untouched", async () => {
    const { executor } = commandExecutor({ exitCode: 0, stdout: "{ broken", stderr: "warn" });
    const { ui, notifications } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(switchExecutor.preparedPaths).toEqual([]);
    expect(switchExecutor.switches).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("{ broken");
    expect(notifications[0]?.message).toContain("warn");
  });

  it("reports a switch path that does not exist without preparing a session", async () => {
    const missing = path.join(tempDir, "gone");
    const { executor } = commandExecutor(switchOutput(missing));
    const { ui, notifications } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(switchExecutor.preparedPaths).toEqual([]);
    expect(switchExecutor.switches).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
  });

  it("retains the prepared target session when preparation fails", async () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "target-")));
    const preparedFile = path.join(sessionDir, "prepared.jsonl");
    fs.writeFileSync(preparedFile, "partial");
    const result = { ...switchOutput(target), stderr: "switch hook diagnostic" };
    const { executor } = commandExecutor(result);
    const { ui, notifications } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor({
      prepareError: new Error("verification failed"),
    });

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(switchExecutor.switches).toEqual([]);
    expect(fs.existsSync(preparedFile)).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("verification failed");
    expect(notifications[0]?.message).toContain(result.stderr);
    expect(notifications[0]?.message).toContain(result.stdout);
  });

  it("reports a failed session replacement instead of letting /wt reject", async () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "target-")));
    const { executor } = commandExecutor(switchOutput(target));
    const { ui, notifications } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor({
      switchError: new Error("runtime replacement failed"),
    });

    await expect(runWorktreePicker(executor, switchExecutor.executor, ui)).resolves.toBeUndefined();

    expect(switchExecutor.preparedPaths).toEqual([target]);
    expect(switchExecutor.switches).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("runtime replacement failed");
  });

  it("reports a record-write failure from the SDK append boundary and does not switch", async () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "target-")));
    const { manager, file } = writeSourceSession(path.join(tempDir, "source"));
    const sourceBefore = fs.readFileSync(file, "utf8");
    const { executor } = commandExecutor({
      ...switchOutput(target),
      stderr: "switch hook diagnostic",
    });
    const { ui, notifications } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor({
      prepareFn: (targetPath, record) =>
        prepareTargetSession(manager, targetPath, record, sessionDir),
    });

    // The Pi SDK session file is the record-write boundary; fail the append
    // once, after the prepared file already exists.
    let appendCalls = 0;
    const appendSpy = vi
      .spyOn(SessionManager.prototype, "appendCustomEntry")
      .mockImplementationOnce(() => {
        throw new Error("session file write failed");
      });

    try {
      await runWorktreePicker(executor, switchExecutor.executor, ui);
    } finally {
      // mockRestore also clears the recorded calls, so capture the count first.
      appendCalls = appendSpy.mock.calls.length;
      appendSpy.mockRestore();
    }

    expect(appendCalls).toBe(1);
    expect(switchExecutor.events).toEqual(["waitForIdle", "prepare"]);
    expect(switchExecutor.switches).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(sourceBefore);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("session file write failed");
    expect(notifications[0]?.message).toContain("switch hook diagnostic");
  });

  it("does nothing when the picker is cancelled", async () => {
    const { executor, calls } = scriptedExecutor({
      exitCode: 0,
      stdout: SCHEMA_2_LIST,
      stderr: "",
    });
    const { ui, notifications } = captureUi(() => null);
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(calls).toEqual([{ args: ["list", "--format=json"], cwd: "/repo" }]);
    expect(switchExecutor.switches).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("treats the current worktree as a no-op", async () => {
    const { executor, calls } = scriptedExecutor({
      exitCode: 0,
      stdout: SCHEMA_2_LIST,
      stderr: "",
    });
    const { ui, notifications } = captureUi(
      (choices) => choices.find((worktree) => worktree.current) ?? null,
    );
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(calls).toEqual([{ args: ["list", "--format=json"], cwd: "/repo" }]);
    expect(switchExecutor.switches).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("info");
    expect(notifications[0]?.message).toContain("Already in");
  });

  it("reports Worktrunk's stderr and stdout on a non-zero list without opening the picker", async () => {
    const { executor } = scriptedExecutor({
      exitCode: 1,
      stdout: "stdout detail",
      stderr: "fatal: not a git repository",
    });
    const { ui, notifications, selections } = captureUi(() => null);
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(selections).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("fatal: not a git repository");
    expect(notifications[0]?.message).toContain("stdout detail");
  });

  it("reports the missing wt binary without changing state", async () => {
    const { executor } = scriptedExecutor({
      exitCode: null,
      stdout: "",
      stderr: "spawn wt ENOENT",
    });
    const { ui, notifications, selections } = captureUi(() => null);
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(selections).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("spawn wt ENOENT");
  });

  it("reports an executor failure instead of throwing", async () => {
    const executor: WtExecutor = async () => {
      throw new Error("spawn failed");
    };
    const { ui, notifications, selections } = captureUi(() => null);
    const switchExecutor = fakeSwitchExecutor();

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    expect(selections).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("spawn failed");
  });
});

describe("findUndeliveredRelocation", () => {
  /** Fresh manager with one user entry so the branch has a root. */
  function relocationSession(): SessionManager {
    const manager = SessionManager.create(path.join(tempDir, "branch-source"), sessionDir);
    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    return manager;
  }

  function appendRecord(manager: SessionManager, targetPath: string): string {
    return manager.appendCustomEntry(RELOCATION_CUSTOM_TYPE, relocationRecord(targetPath));
  }

  function markDelivered(manager: SessionManager, recordId: string): string {
    return manager.appendCustomMessageEntry(RELOCATION_CUSTOM_TYPE, "delivered note", false, {
      relocationId: recordId,
    });
  }

  function undelivered(manager: SessionManager, cwd: string): RelocationDelivery | null {
    return findUndeliveredRelocation(manager.getBranch(), cwd);
  }

  it("returns the latest record's id and note when it has not been delivered", () => {
    const manager = relocationSession();
    const recordId = appendRecord(manager, "/repo.target");

    expect(undelivered(manager, "/repo.target")).toEqual({
      relocationId: recordId,
      note: relocationRecord("/repo.target").note,
    });
  });

  it("returns nothing once a custom message carrying the record id has been delivered", () => {
    const manager = relocationSession();
    const recordId = appendRecord(manager, "/repo.target");
    markDelivered(manager, recordId);

    expect(undelivered(manager, "/repo.target")).toBeNull();
  });

  it("lets the latest record supersede earlier undelivered records", () => {
    const manager = relocationSession();
    appendRecord(manager, "/repo.target");
    const secondId = appendRecord(manager, "/repo.target");

    expect(undelivered(manager, "/repo.target")?.relocationId).toBe(secondId);
  });

  it("delivers nothing when the latest record is delivered, even if an earlier one is not", () => {
    const manager = relocationSession();
    appendRecord(manager, "/repo.target");
    const latestId = appendRecord(manager, "/repo.target");
    markDelivered(manager, latestId);

    expect(undelivered(manager, "/repo.target")).toBeNull();
  });

  it("uses the delivered marker of the latest record, not an older one", () => {
    const manager = relocationSession();
    const firstId = appendRecord(manager, "/repo.target");
    markDelivered(manager, firstId);
    const secondId = appendRecord(manager, "/repo.target");

    expect(undelivered(manager, "/repo.target")?.relocationId).toBe(secondId);
  });

  it("never falls back to an older record whose target cwd matches", () => {
    const manager = relocationSession();
    appendRecord(manager, "/repo.target");
    appendRecord(manager, "/repo.elsewhere");

    expect(undelivered(manager, "/repo.target")).toBeNull();
  });

  it("returns nothing when the branch has no relocation records", () => {
    const manager = relocationSession();

    expect(undelivered(manager, "/repo.target")).toBeNull();
  });
});

describe("renderRelocationEntry", () => {
  function recordEntry(id: string): CustomEntry<RelocationRecord> {
    return {
      type: "custom",
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: RELOCATION_CUSTOM_TYPE,
      data: relocationRecord("/repo.target"),
    };
  }

  function renderedText(component: Component): string {
    return component.render(120).join(" ").replace(/\s+/g, " ");
  }

  it("renders the note as a durable transcript line", () => {
    const theme = { fg: (_color: PickerColor, text: string) => text };
    const component = renderRelocationEntry(recordEntry("r1"), { expanded: false }, theme);
    if (!component) throw new Error("entry rendered nothing");

    expect(renderedText(component)).toContain(relocationRecord("/repo.target").note);
  });

  it("shows the relocation path detail when expanded", () => {
    const theme = { fg: (_color: PickerColor, text: string) => text };
    const component = renderRelocationEntry(recordEntry("r1"), { expanded: true }, theme);
    if (!component) throw new Error("entry rendered nothing");

    expect(renderedText(component)).toContain("branch main");
  });

  it("renders nothing for an entry without record data", () => {
    const theme = { fg: (_color: PickerColor, text: string) => text };
    const component = renderRelocationEntry(
      { ...recordEntry("r1"), data: undefined },
      { expanded: false },
      theme,
    );

    expect(component).toBeUndefined();
  });
});

/** Register the extension against the seam and return it. */
function registeredExtension(overrides?: { sendMessageError?: Error }) {
  const seam = fakePi(overrides);
  registerWorktrunk(seam.pi, async () => ({ exitCode: 0, stdout: SCHEMA_2_LIST, stderr: "" }));
  return seam;
}

describe("session_start relocation queueing", () => {
  function relocatedSession(): { manager: SessionManager; recordId: string } {
    const { manager } = writeSourceSession(path.join(tempDir, "source"));
    const target = path.join(tempDir, "target");
    const prepared = prepareTargetSession(manager, target, relocationRecord(target), sessionDir);
    const reopened = SessionManager.open(prepared);
    const leaf = reopened.getLeafEntry();
    if (leaf?.type !== "custom") throw new Error("prepared session has no relocation record");
    return { manager: reopened, recordId: leaf.id };
  }

  it("reconstructs the nextTurn queue after a close by requeueing the undelivered note", async () => {
    const { manager, recordId } = relocatedSession();
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    // Fresh runtime after close/reopen: reason "resume" (switch) or "startup".
    await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "resume",
      path.join(tempDir, "target"),
      manager,
    );

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0]!;
    expect(sent.message.customType).toBe(RELOCATION_CUSTOM_TYPE);
    expect(sent.message.display).toBe(false);
    expect(sent.message.content).toBe(relocationNoteFor(path.join(tempDir, "target"), "main"));
    expect(sent.message.details).toEqual({ relocationId: recordId });
    expect(sent.options).toEqual({ deliverAs: "nextTurn" });
  });

  it("also requeues on startup", async () => {
    const { manager } = relocatedSession();
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "startup",
      path.join(tempDir, "target"),
      manager,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.options).toEqual({ deliverAs: "nextTurn" });
  });

  it("does not requeue on reload because the same runtime keeps its nextTurn queue", async () => {
    const { manager } = relocatedSession();
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "resume",
      path.join(tempDir, "target"),
      manager,
    );
    expect(sentMessages).toHaveLength(1);

    await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "reload",
      path.join(tempDir, "target"),
      manager,
    );
    expect(sentMessages).toHaveLength(1);
  });

  it("does not queue when the note was already delivered and persisted with the record id", async () => {
    const { manager, recordId } = relocatedSession();
    manager.appendCustomMessageEntry(RELOCATION_CUSTOM_TYPE, "relocation note", false, {
      relocationId: recordId,
    });
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "resume",
      path.join(tempDir, "target"),
      manager,
    );

    expect(sentMessages).toEqual([]);
  });

  it("queues only the latest record across multiple relocations", async () => {
    const { manager } = relocatedSession();
    const secondTarget = path.join(tempDir, "target-2");
    manager.appendCustomEntry(RELOCATION_CUSTOM_TYPE, relocationRecord(secondTarget, "main"));
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    await dispatchSessionStart(sessionStartHandlers[0]!, "resume", secondTarget, manager);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message.content).toBe(relocationNoteFor(secondTarget, "main"));
  });

  it("delivers nothing when the latest record is delivered, even with earlier undelivered records", async () => {
    const { manager } = relocatedSession();
    const latest = manager.getLeafEntry();
    if (latest?.type !== "custom") throw new Error("expected relocation record");
    manager.appendCustomMessageEntry(RELOCATION_CUSTOM_TYPE, "note", false, {
      relocationId: latest.id,
    });
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "resume",
      path.join(tempDir, "target"),
      manager,
    );

    expect(sentMessages).toEqual([]);
  });

  it("ignores a relocation record whose target cwd does not match the session cwd", async () => {
    const { manager } = relocatedSession();
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    await dispatchSessionStart(sessionStartHandlers[0]!, "resume", "/somewhere/else", manager);

    expect(sentMessages).toEqual([]);
  });

  it("ignores relocation records that are not on the active branch", async () => {
    const { manager, recordId } = relocatedSession();
    const beforeRecord = manager.getEntries()[0];
    if (!beforeRecord) throw new Error("expected carried entries");
    manager.branch(beforeRecord.id);
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "resume",
      path.join(tempDir, "target"),
      manager,
    );

    expect(manager.getBranch().some((entry) => entry.id === recordId)).toBe(false);
    expect(sentMessages).toEqual([]);
  });

  it("reports a synchronous send failure on the session_start context and leaves the record for retry", async () => {
    const { manager } = relocatedSession();
    const { sessionStartHandlers, sentMessages } = registeredExtension({
      sendMessageError: new Error("session file is read-only"),
    });

    const notifications = await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "resume",
      path.join(tempDir, "target"),
      manager,
    );

    expect(sentMessages).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain(
      "relocation record is saved and can be retried on resume",
    );
    // The record is still on the branch, so a later session start retries.
    expect(
      findUndeliveredRelocation(manager.getBranch(), path.join(tempDir, "target")),
    ).not.toBeNull();
  });

  it("does nothing on a session without relocation records", async () => {
    const { manager } = writeSourceSession(path.join(tempDir, "source"));
    const { sessionStartHandlers, sentMessages } = registeredExtension();

    await dispatchSessionStart(
      sessionStartHandlers[0]!,
      "resume",
      path.join(tempDir, "source"),
      manager,
    );

    expect(sentMessages).toEqual([]);
  });
});

describe("worktrunk extension", () => {
  it("registers /wt, the relocation entry renderer and the session_start handler", () => {
    const { pi, commands, entryRenderers, sessionStartHandlers } = fakePi();

    registerWorktrunk(pi, async () => ({ exitCode: 0, stdout: SCHEMA_2_LIST, stderr: "" }));

    expect(commands).toEqual(["wt"]);
    expect(entryRenderers).toEqual([
      { customType: RELOCATION_CUSTOM_TYPE, renderer: renderRelocationEntry },
    ]);
    expect(sessionStartHandlers).toHaveLength(1);
  });

  it("persists the record before the switch and the new runtime requeues the note for the next prompt", async () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "target-")));
    const { manager } = writeSourceSession(path.join(tempDir, "source"));
    const { executor } = commandExecutor({
      exitCode: 0,
      stdout: JSON.stringify({ action: "existing", branch: "main", path: target }),
      stderr: "",
    });
    const { ui } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );
    const switchExecutor = fakeSwitchExecutor({
      prepareFn: (targetPath, record) =>
        prepareTargetSession(manager, targetPath, record, sessionDir),
    });

    await runWorktreePicker(executor, switchExecutor.executor, ui);

    // The record is durable in the prepared session before the runtime switch.
    const preparedFile = switchExecutor.switches[0]?.file;
    expect(preparedFile).toBeDefined();
    const reopened = SessionManager.open(preparedFile!);
    expect(reopened.getCwd()).toBe(target);
    const recordEntry = reopened.getEntries().at(-1);
    expect(recordEntry?.type).toBe("custom");
    if (recordEntry?.type !== "custom") throw new Error("expected relocation record");
    expect(recordEntry.data).toEqual({
      branch: "main",
      sourcePath: "/repo",
      targetPath: target,
      note: expect.stringContaining(target),
    });

    // The replacement runtime's session_start requeues the LLM-facing note.
    const { sessionStartHandlers, sentMessages } = registeredExtension();
    await dispatchSessionStart(sessionStartHandlers[0]!, "resume", target, reopened);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message.display).toBe(false);
    expect(sentMessages[0]?.message.details).toEqual({ relocationId: recordEntry.id });
    expect(sentMessages[0]?.options).toEqual({ deliverAs: "nextTurn" });
  });
});
