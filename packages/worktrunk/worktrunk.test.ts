import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerWorktrunk } from "./index.ts";
import { parseWorktreeList, runWorktreeList, type WtExecutor, type WtResult } from "./worktrunk.ts";

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
      display: { state: "diverged", symbols: "+!↕", statusline: "feature-api …" },
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

function captureUi(cwd = "/repo") {
  const notifications: Array<{ message: string; type: "info" | "warning" | "error" }> = [];
  return {
    notifications,
    ui: {
      cwd,
      notify: (message: string, type: "info" | "warning" | "error") =>
        notifications.push({ message, type }),
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

describe("runWorktreeList", () => {
  it("runs wt list with argv and reports the parsed worktrees", async () => {
    const { executor, calls } = scriptedExecutor({
      exitCode: 0,
      stdout: SCHEMA_2_LIST,
      stderr: "",
    });
    const { ui, notifications } = captureUi("/repo");

    await runWorktreeList(executor, ui);

    expect(calls).toEqual([{ args: ["list", "--format=json"], cwd: "/repo" }]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("info");
    expect(notifications[0]?.message).toContain("feature-api");
    expect(notifications[0]?.message).toContain("main");
    expect(notifications[0]?.message).toContain("+54 -5");
    expect(notifications[0]?.message).toContain("🤖");
  });

  it("reports Worktrunk's stderr and stdout on a non-zero exit", async () => {
    const { executor } = scriptedExecutor({
      exitCode: 1,
      stdout: "stdout detail",
      stderr: "fatal: not a git repository",
    });
    const { ui, notifications } = captureUi();

    await runWorktreeList(executor, ui);

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
    const { ui, notifications } = captureUi();

    await runWorktreeList(executor, ui);

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
    const { ui, notifications } = captureUi();

    await runWorktreeList(executor, ui);

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
    const { ui, notifications } = captureUi();

    await runWorktreeList(executor, ui);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("schema");
  });

  it("reports an executor failure instead of throwing", async () => {
    const executor: WtExecutor = async () => {
      throw new Error("spawn failed");
    };
    const { ui, notifications } = captureUi();

    await runWorktreeList(executor, ui);

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
