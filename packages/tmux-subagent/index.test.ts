import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index.ts";
import { REPORT_POLL_MS, reportEnvelope } from "./parent.ts";
import { createStore, type ReportRecord } from "./store.ts";
import { createFakePi } from "./test-support.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalNonce = process.env.PI_SUBAGENT_NONCE;
let rootDir: string;
let userAgentsDir: string;
let projectDir: string;
let projectAgentsDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-adapter-"));
  userAgentsDir = path.join(rootDir, "user", "agents");
  projectDir = path.join(rootDir, "project");
  projectAgentsDir = path.join(projectDir, ".pi", "agents");
  fs.mkdirSync(userAgentsDir, { recursive: true });
  fs.mkdirSync(projectAgentsDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = path.dirname(userAgentsDir);
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalNonce === undefined) delete process.env.PI_SUBAGENT_NONCE;
  else process.env.PI_SUBAGENT_NONCE = originalNonce;
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function writeAgent(directory: string, fileName: string, name: string, description: string): void {
  fs.writeFileSync(
    path.join(directory, fileName),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

function harness(trusted: boolean) {
  const fake = createFakePi();
  fake.state.cwd = projectDir;
  fake.state.trusted = trusted;
  extension(fake.pi);
  return fake;
}

type Tool = {
  name: string;
  description: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
};

function latestTool(fake: ReturnType<typeof createFakePi>): Tool {
  const tool = fake.tools.at(-1) as Tool | undefined;
  if (!tool) throw new Error("subagent tool was not registered");
  return tool;
}

async function listing(tool: Tool): Promise<string> {
  return (await tool.execute("call", {}, undefined, undefined, {} as ExtensionContext)).content[0]
    .text;
}

describe("parent mode", () => {
  it("keeps description, listing, and resolution on one catalog snapshot until the next session", async () => {
    writeAgent(userAgentsDir, "stable.md", "stable", "initial definition");
    writeAgent(
      projectAgentsDir,
      "project-stable.md",
      "project-stable",
      "initial project definition",
    );
    const fake = harness(true);
    await fake.emit("session_start", { reason: "startup" });
    const firstTool = latestTool(fake);

    fs.rmSync(path.join(userAgentsDir, "stable.md"));
    writeAgent(userAgentsDir, "later.md", "later", "added after snapshot");

    expect(firstTool.name).toBe("subagent");
    expect(firstTool.description).toContain("stable — initial definition");
    expect(firstTool.description).toContain("project-stable — initial project definition");
    expect(firstTool.description).not.toContain("later — added after snapshot");
    expect(await listing(firstTool)).toContain("stable — initial definition");
    const unknown = await firstTool.execute(
      "call",
      { tasks: [{ agent: "later", instruction: "Review" }] },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(unknown.content[0].text).toContain('Unknown agent "later"');

    await fake.emit("session_start", { reason: "new" });
    const nextTool = latestTool(fake);
    expect(nextTool.description).toContain("later — added after snapshot");
    expect(nextTool.description).not.toContain("stable — initial definition");
    await fake.emit("session_shutdown", { reason: "quit" });
  });

  it("never exposes project agents when the project is untrusted", async () => {
    writeAgent(userAgentsDir, "user.md", "user", "global definition");
    writeAgent(projectAgentsDir, "project.md", "project", "local definition");
    const fake = harness(false);
    await fake.emit("session_start", { reason: "startup" });
    const tool = latestTool(fake);

    expect(tool.description).toContain("user — global definition");
    expect(tool.description).not.toContain("project — local definition");
    expect(await listing(tool)).not.toContain("project — local definition");
    await fake.emit("session_shutdown", { reason: "quit" });
  });

  it("delivers reports absent from the session's history as follow-ups, once confirmed persisted", async () => {
    vi.useFakeTimers();
    try {
      const store = createStore(path.join(path.dirname(userAgentsDir), "subagents"));
      const childId = store.createChild(
        {
          parent: { sessionId: "parent-session" },
          worktree: projectDir,
          cwd: projectDir,
          agent: { name: "scout", source: "user" },
          projectTrust: false,
          depth: 1,
          piCommand: ["/node", "/pi/cli.js"],
        },
        "",
      ).childId;
      for (const content of ["Old news", "Fresh finding"]) {
        store.createReport({ childId, parentSessionId: "parent-session", agent: "scout", content });
      }
      const fake = harness(true);
      // m1 was delivered on a branch other than the active one.
      fake.state.entries = [
        {
          type: "custom_message",
          id: "e1",
          customType: "subagent_report",
          content: "…",
          display: true,
          details: { childId, reportId: "m1" },
        },
      ];
      await fake.emit("session_start", { reason: "resume" });

      await vi.advanceTimersByTimeAsync(REPORT_POLL_MS);
      expect(fake.customMessages).toEqual([
        {
          message: {
            customType: "subagent_report",
            content: reportEnvelope(store.readReport(childId, "m2") as ReportRecord),
            display: true,
            details: { childId, reportId: "m2" },
          },
          options: { deliverAs: "followUp", triggerTurn: true },
        },
      ]);

      await fake.emit("message_end", {
        message: { role: "custom", ...fake.customMessages[0].message, timestamp: 0 },
      });
      await vi.advanceTimersByTimeAsync(REPORT_POLL_MS * 3);
      expect(fake.customMessages).toHaveLength(1);

      // Delivery stops on every shutdown, including reload, which is no departure.
      await fake.emit("session_shutdown", { reason: "reload" });
      store.createReport({
        childId,
        parentSessionId: "parent-session",
        agent: "scout",
        content: "x",
      });
      await vi.advanceTimersByTimeAsync(REPORT_POLL_MS * 2);
      expect(fake.customMessages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parent departure", () => {
  function stateStore() {
    return createStore(path.join(path.dirname(userAgentsDir), "subagents"));
  }

  function createChild(store: ReturnType<typeof stateStore>, parentSessionId: string): string {
    return store.createChild(
      {
        parent: { sessionId: parentSessionId },
        worktree: projectDir,
        cwd: projectDir,
        agent: { name: "scout", source: "user" },
        projectTrust: false,
        depth: 1,
        piCommand: ["/node", "/pi/cli.js"],
      },
      "",
    ).childId;
  }

  it.each(["quit", "new", "resume", "fork"])(
    "drains this session's children on %s",
    async (reason) => {
      const store = stateStore();
      const mine = createChild(store, "parent-session");
      const other = createChild(store, "other-session");
      const fake = harness(true);
      await fake.emit("session_start", { reason: "startup" });

      await fake.emit("session_shutdown", { reason });

      expect(store.hasDrain(mine)).toBe(true);
      expect(store.hasDrain(other)).toBe(false);
    },
  );

  it("never drains on reload", async () => {
    const store = stateStore();
    const mine = createChild(store, "parent-session");
    const fake = harness(true);
    await fake.emit("session_start", { reason: "startup" });

    await fake.emit("session_shutdown", { reason: "reload" });
    await fake.emit("session_start", { reason: "reload" });

    expect(store.hasDrain(mine)).toBe(false);
  });

  it("drains the departing session's children, not those of the session started next", async () => {
    const store = stateStore();
    const first = createChild(store, "first-session");
    const second = createChild(store, "second-session");
    const fake = harness(true);
    fake.state.sessionId = "first-session";
    await fake.emit("session_start", { reason: "startup" });

    await fake.emit("session_shutdown", { reason: "new" });
    fake.state.sessionId = "second-session";
    await fake.emit("session_start", { reason: "new" });

    expect(store.hasDrain(first)).toBe(true);
    expect(store.hasDrain(second)).toBe(false);
  });

  it("cancels an earlier drain when the parent conversation is resumed", async () => {
    const store = stateStore();
    const mine = createChild(store, "parent-session");
    const other = createChild(store, "other-session");
    store.writeDrain(mine);
    store.writeDrain(other);
    const fake = harness(true);

    await fake.emit("session_start", { reason: "resume" });

    expect(store.hasDrain(mine)).toBe(false);
    expect(store.hasDrain(other)).toBe(true);
  });

  it("logs a drain that failed instead of throwing or reporting success", async () => {
    const store = stateStore();
    fs.mkdirSync(store.root, { recursive: true });
    fs.writeFileSync(path.join(store.root, "children"), "not a directory");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = harness(true);
    await fake.emit("session_start", { reason: "startup" });
    logged.mockClear();

    await expect(fake.emit("session_shutdown", { reason: "quit" })).resolves.toBeDefined();

    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/could not drain/i));
    logged.mockRestore();
  });

  it("logs each child it could not drain", async () => {
    const store = stateStore();
    const corrupt = createChild(store, "parent-session");
    fs.writeFileSync(path.join(store.childDir(corrupt), "child.json"), "{}");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = harness(true);
    await fake.emit("session_start", { reason: "startup" });
    logged.mockClear();

    await fake.emit("session_shutdown", { reason: "quit" });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining(corrupt));
    logged.mockRestore();
  });

  it("registers the follow-up tools, which refuse another parent's child", async () => {
    const store = createStore(path.join(path.dirname(userAgentsDir), "subagents"));
    const foreign = store.createChild(
      {
        parent: { sessionId: "other-session" },
        worktree: projectDir,
        cwd: projectDir,
        agent: { name: "scout", source: "user" },
        projectTrust: false,
        depth: 1,
        piCommand: ["/node", "/pi/cli.js"],
      },
      "",
    );
    store.createRequest(foreign.childId, "Task");
    const fake = harness(true);
    await fake.emit("session_start", { reason: "startup" });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
      "subagent",
      "subagent_ask",
      "subagent_retrieve",
    ]);
    const byName = (name: string) => fake.tools.find((tool) => tool.name === name) as Tool;
    const ask = await byName("subagent_ask").execute(
      "call",
      { childId: foreign.childId, instruction: "Mine now" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(ask.content[0].text).toContain("another parent");
    await expect(
      byName("subagent_retrieve").execute(
        "call",
        { childId: foreign.childId, requestId: "r1" },
        undefined,
        undefined,
        {} as ExtensionContext,
      ),
    ).rejects.toThrow(/another parent/);
  });
});

describe("child mode", () => {
  function childHarness() {
    const store = createStore(path.join(rootDir, "subagents"));
    const child = store.createChild(
      {
        parent: { sessionId: "parent" },
        worktree: projectDir,
        cwd: projectDir,
        agent: { name: "scout", source: "user" },
        projectTrust: false,
        depth: 1,
        piCommand: ["/node", "/pi/cli.js"],
      },
      "",
    );
    const fake = harness(true);
    fake.flags["subagent-child"] = store.childDir(child.childId);
    return { fake, store, childId: child.childId };
  }

  it("starts the bridge and registers only subagent_report, signalling readiness with the launch nonce", async () => {
    process.env.PI_SUBAGENT_NONCE = "launch-nonce";
    const { fake, store, childId } = childHarness();

    await fake.emit("session_start", { reason: "startup" });

    expect(fake.tools.map((tool) => tool.name)).toEqual(["subagent_report"]);
    const report = latestTool(fake);
    expect(
      (await report.execute("call", { content: "Note" }, undefined, undefined, fake.ctx)).content[0]
        .text,
    ).toBe("Report m1 queued for the parent");
    expect(store.readReport(childId, "m1")).toMatchObject({ parentSessionId: "parent" });
    expect(store.readStatus(childId)).toMatchObject({ nonce: "launch-nonce", state: "idle" });
    await fake.emit("session_shutdown", { reason: "quit" });
  });

  it("keeps the launch nonce across /reload, so status.json stays valid for readiness", async () => {
    process.env.PI_SUBAGENT_NONCE = "launch-nonce";
    const { fake, store, childId } = childHarness();
    await fake.emit("session_start", { reason: "startup" });
    await fake.emit("session_shutdown", { reason: "reload" });
    fs.rmSync(path.join(store.childDir(childId), "status.json"));

    await fake.emit("session_start", { reason: "reload" });

    expect(process.env.PI_SUBAGENT_NONCE).toBe("launch-nonce");
    expect(store.readStatus(childId)).toMatchObject({ nonce: "launch-nonce" });
    await fake.emit("session_shutdown", { reason: "quit" });
  });

  it("refuses to run as a child without a launch nonce", async () => {
    delete process.env.PI_SUBAGENT_NONCE;
    const { fake, store, childId } = childHarness();

    await expect(fake.emit("session_start", { reason: "startup" })).rejects.toThrow(
      /PI_SUBAGENT_NONCE/,
    );
    expect(store.readStatus(childId)).toBeUndefined();
  });
});
