import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerWorktrunk } from "./index.ts";
import {
  buildWorktreeRows,
  type PickerColor,
  parseWorktreeList,
  runWorktreePicker,
  type Worktree,
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

interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

function captureUi(choose: (worktrees: Worktree[]) => Worktree | null, cwd = "/repo") {
  const notifications: Notification[] = [];
  const selections: Worktree[][] = [];
  return {
    notifications,
    selections,
    ui: {
      cwd,
      notify: (message: string, type: Notification["type"]) =>
        notifications.push({ message, type }),
      selectWorktree: async (worktrees: readonly Worktree[]) => {
        selections.push([...worktrees]);
        return choose([...worktrees]);
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

describe("runWorktreePicker", () => {
  it("lists worktrees, opens the picker and reports the current worktree as a no-op", async () => {
    const { executor, calls } = scriptedExecutor({
      exitCode: 0,
      stdout: SCHEMA_2_LIST,
      stderr: "",
    });
    const { ui, notifications, selections } = captureUi(
      (choices) => choices.find((worktree) => worktree.current) ?? null,
    );

    await runWorktreePicker(executor, ui);

    expect(calls).toEqual([{ args: ["list", "--format=json"], cwd: "/repo" }]);
    expect(selections[0]?.map((worktree) => worktree.branch)).toEqual(["feature-api", "main"]);
    expect(notifications).toEqual([
      { message: expect.stringContaining("feature-api"), type: "info" },
    ]);
    expect(notifications[0]?.message).toContain("Already in");
  });

  it("reports the chosen branch for another worktree without switching", async () => {
    const { executor, calls } = scriptedExecutor({
      exitCode: 0,
      stdout: SCHEMA_2_LIST,
      stderr: "",
    });
    const { ui, notifications } = captureUi(
      (choices) => choices.find((worktree) => worktree.branch === "main") ?? null,
    );

    await runWorktreePicker(executor, ui);

    expect(calls).toEqual([{ args: ["list", "--format=json"], cwd: "/repo" }]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("info");
    expect(notifications[0]?.message).toContain("main");
  });

  it("stays silent and unchanged when the picker is cancelled", async () => {
    const { executor, calls } = scriptedExecutor({
      exitCode: 0,
      stdout: SCHEMA_2_LIST,
      stderr: "",
    });
    const { ui, notifications } = captureUi(() => null);

    await runWorktreePicker(executor, ui);

    expect(calls).toEqual([{ args: ["list", "--format=json"], cwd: "/repo" }]);
    expect(notifications).toEqual([]);
  });

  it("reports an empty listing instead of opening an empty picker", async () => {
    const { executor } = scriptedExecutor({
      exitCode: 0,
      stdout: JSON.stringify({ schema: 2, items: [] }),
      stderr: "",
    });
    const { ui, notifications, selections } = captureUi(() => null);

    await runWorktreePicker(executor, ui);

    expect(selections).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("info");
  });

  it("reports Worktrunk's stderr and stdout on a non-zero exit without opening the picker", async () => {
    const { executor } = scriptedExecutor({
      exitCode: 1,
      stdout: "stdout detail",
      stderr: "fatal: not a git repository",
    });
    const { ui, notifications, selections } = captureUi(() => null);

    await runWorktreePicker(executor, ui);

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

    await runWorktreePicker(executor, ui);

    expect(selections).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("spawn wt ENOENT");
  });

  it("reports malformed JSON together with the CLI's stdout and stderr", async () => {
    const { executor } = scriptedExecutor({
      exitCode: 0,
      stdout: "{ broken",
      stderr: "warning: schema drift",
    });
    const { ui, notifications, selections } = captureUi(() => null);

    await runWorktreePicker(executor, ui);

    expect(selections).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("{ broken");
    expect(notifications[0]?.message).toContain("warning: schema drift");
  });

  it("reports unexpected envelope output together with the raw output", async () => {
    const { executor } = scriptedExecutor({
      exitCode: 0,
      stdout: JSON.stringify([{ branch: "main" }]),
      stderr: "",
    });
    const { ui, notifications, selections } = captureUi(() => null);

    await runWorktreePicker(executor, ui);

    expect(selections).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("schema");
  });

  it("reports an executor failure instead of throwing", async () => {
    const executor: WtExecutor = async () => {
      throw new Error("spawn failed");
    };
    const { ui, notifications, selections } = captureUi(() => null);

    await runWorktreePicker(executor, ui);

    expect(selections).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("spawn failed");
  });
});

describe("worktrunk extension", () => {
  it("registers a single /wt command", () => {
    const registered: string[] = [];
    const pi = {
      registerCommand: (name: string) => {
        registered.push(name);
      },
    } as unknown as ExtensionAPI;

    registerWorktrunk(pi, async () => ({ exitCode: 0, stdout: SCHEMA_2_LIST, stderr: "" }));

    expect(registered).toEqual(["wt"]);
  });
});
