import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverProjectAgents, discoverUserAgents, mergeAgentLists } from "./agents.js";
import { DELEGATED_TASK_FILE_FLAG, DELEGATED_TASK_PLACEHOLDER } from "./herdr/session.js";
import extension from "./index.js";

/**
 * When set, `fs.readFileSync` throws an EACCES-like error for exactly this
 * path and delegates every other path to the real implementation.
 */
const unreadableFixture = vi.hoisted(() => ({ path: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realReadFileSync = actual.readFileSync;
  const nodePath = await import("node:path");
  const readFileSync = ((file: string | Buffer, ...rest: unknown[]) => {
    if (
      unreadableFixture.path !== null &&
      typeof file === "string" &&
      nodePath.resolve(file) === unreadableFixture.path
    ) {
      const error: NodeJS.ErrnoException = new Error(`EACCES: permission denied, open '${file}'`);
      error.code = "EACCES";
      throw error;
    }
    return (realReadFileSync as (file: string | Buffer, ...rest: unknown[]) => string | Buffer)(
      file,
      ...rest,
    );
  }) as typeof fs.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let rootDir: string;
let userAgentsDir: string;
let projectDir: string;
let projectAgentsDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "callable-agent-catalog-"));
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
  unreadableFixture.path = null;
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function writeAgent(directory: string, fileName: string, name: string, description: string): void {
  fs.writeFileSync(
    path.join(directory, fileName),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

function createExtensionHarness(
  trusted: boolean,
  flagValues: Record<string, boolean | string | undefined> = {},
): {
  startSession(): void;
  transformInput(text: string): Promise<InputEventResult | undefined>;
  tools: Array<Record<string, unknown>>;
} {
  let sessionStart: ((event: SessionStartEvent, ctx: ExtensionContext) => void) | undefined;
  let inputHandler:
    | ((
        event: InputEvent,
        ctx: ExtensionContext,
      ) => InputEventResult | undefined | Promise<InputEventResult | undefined>)
    | undefined;
  const tools: Array<Record<string, unknown>> = [];
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        sessionStart = handler as (event: SessionStartEvent, ctx: ExtensionContext) => void;
      } else if (event === "input") {
        inputHandler = handler as typeof inputHandler;
      }
    },
    registerFlag() {},
    getFlag(name: string) {
      return flagValues[name];
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  extension(pi);

  return {
    startSession() {
      if (!sessionStart) throw new Error("session_start handler was not registered");
      sessionStart(
        { reason: "startup" } as SessionStartEvent,
        {
          cwd: projectDir,
          isProjectTrusted: () => trusted,
        } as ExtensionContext,
      );
    },
    async transformInput(text: string) {
      if (!inputHandler) return { action: "continue" };
      return inputHandler(
        { type: "input", text, source: "interactive" } as InputEvent,
        {} as ExtensionContext,
      );
    },
    tools,
  };
}

async function executeTool(
  tool: Record<string, unknown>,
  params: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const execute = tool.execute as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  return execute("tool-call", params, undefined, undefined, {} as ExtensionContext);
}

describe("agent discovery", () => {
  it("preserves parsing, nearest-project traversal, and project precedence", () => {
    writeAgent(userAgentsDir, "shared.md", "shared", "user definition");
    writeAgent(userAgentsDir, "uppercase.md", "Shared", "case-sensitive definition");
    writeAgent(userAgentsDir, "user.md", "user", "user only");
    fs.writeFileSync(path.join(userAgentsDir, "malformed.md"), "---\nname: malformed\n");
    const unreadablePath = path.join(userAgentsDir, "unreadable.md");
    writeAgent(userAgentsDir, "unreadable.md", "unreadable", "unreadable definition");
    fs.writeFileSync(
      path.join(userAgentsDir, "configured.md"),
      "---\nname: configured\ndescription: configured agent\ntools: read, bash\nmodel: provider/model\n---\nKeep this prompt.\n",
    );
    writeAgent(projectAgentsDir, "shared.md", "shared", "project definition");
    const nestedDir = path.join(projectDir, "nested", "child");
    const nearerAgentsDir = path.join(projectDir, "nested", ".pi", "agents");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(nearerAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(nearerAgentsDir, "missing-description.md"),
      "---\nname: ignored\n---\n",
    );

    // Deterministic unreadable-file fixture: only unreadable.md rejects reads
    // with an EACCES-like error; every other path goes to the real fs.
    unreadableFixture.path = path.resolve(unreadablePath);
    const merged = mergeAgentLists(discoverUserAgents(), discoverProjectAgents(nestedDir));
    unreadableFixture.path = null;

    expect(merged.map(({ name }) => name).sort()).toEqual(
      ["configured", "shared", "Shared", "user"].sort(),
    );
    expect(merged.some(({ name }) => name === "unreadable")).toBe(false);
    expect(merged.find(({ name }) => name === "shared")?.description).toBe("project definition");
    expect(merged.find(({ name }) => name === "configured")).toMatchObject({
      tools: ["read", "bash"],
      model: "provider/model",
      systemPromptBody: "Keep this prompt.",
    });
  });
});

describe("delegated task input", () => {
  it("replaces the private startup placeholder for a delegated-task lease once", async () => {
    const taskFile = path.join(rootDir, "task.md");
    const task = "--review '世界' with sanitized spacing";
    fs.writeFileSync(taskFile, task, "utf8");
    const harness = createExtensionHarness(true, {
      [DELEGATED_TASK_FILE_FLAG]: taskFile,
    });

    await expect(harness.transformInput(DELEGATED_TASK_PLACEHOLDER)).resolves.toEqual({
      action: "transform",
      text: task,
    });
    await expect(harness.transformInput(DELEGATED_TASK_PLACEHOLDER)).resolves.toEqual({
      action: "continue",
    });
  });

  it("ignores private task input without a delegated-task lease", async () => {
    const taskFile = path.join(rootDir, "ordinary-session.md");
    fs.writeFileSync(taskFile, "must not be loaded", "utf8");
    const harness = createExtensionHarness(true);

    await expect(
      harness.transformInput(`${DELEGATED_TASK_PLACEHOLDER}:${taskFile}`),
    ).resolves.toEqual({ action: "continue" });
  });
});

describe("callable agent catalog lifecycle", () => {
  it("keeps description, listing, and resolution on one snapshot until the next session", async () => {
    writeAgent(userAgentsDir, "stable.md", "stable", "initial definition");
    writeAgent(
      projectAgentsDir,
      "project-stable.md",
      "project-stable",
      "initial project definition",
    );
    const harness = createExtensionHarness(true);
    harness.startSession();
    const firstTool = harness.tools.at(-1);
    if (!firstTool) throw new Error("subagent tool was not registered");

    fs.rmSync(path.join(userAgentsDir, "stable.md"));
    fs.rmSync(path.join(projectAgentsDir, "project-stable.md"));
    writeAgent(userAgentsDir, "later.md", "later", "added after snapshot");
    writeAgent(projectAgentsDir, "project-later.md", "project-later", "added after snapshot");

    expect(firstTool.description).toContain("stable — initial definition");
    expect(firstTool.description).toContain("project-stable — initial project definition");
    expect(firstTool.description).not.toContain("later — added after snapshot");
    expect(firstTool.description).not.toContain("project-later — added after snapshot");
    expect((await executeTool(firstTool, {})).content[0].text).toContain(
      "stable — initial definition",
    );
    expect((await executeTool(firstTool, {})).content[0].text).not.toContain(
      "later — added after snapshot",
    );
    const unknownAgentText = (
      await executeTool(firstTool, { tasks: [{ agent: "later", instruction: "Review" }] })
    ).content[0].text;
    expect(unknownAgentText).toContain('Unknown agent "later"');
    expect(unknownAgentText).toContain("stable — initial definition");
    expect(unknownAgentText).toContain("project-stable — initial project definition");
    expect(unknownAgentText).not.toContain("project-later — added after snapshot");

    const herdrEnv = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    try {
      await expect(
        executeTool(firstTool, {
          tasks: [{ agent: "stable", instruction: "Review" }],
        }),
      ).rejects.toThrow("requires this pi to run inside Herdr");
    } finally {
      if (herdrEnv === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = herdrEnv;
    }

    const taskCwd = path.join(rootDir, "task-cwd");
    const taskCwdAgentsDir = path.join(taskCwd, ".pi", "agents");
    fs.mkdirSync(taskCwdAgentsDir, { recursive: true });
    writeAgent(taskCwdAgentsDir, "cwd-only.md", "cwd-only", "task cwd definition");
    expect(
      (
        await executeTool(firstTool, {
          tasks: [{ agent: "cwd-only", instruction: "Review", cwd: taskCwd }],
        })
      ).content[0].text,
    ).toContain('Unknown agent "cwd-only"');

    harness.startSession();
    const nextTool = harness.tools.at(-1);
    if (!nextTool) throw new Error("subagent tool was not registered");
    expect(nextTool.description).toContain("later — added after snapshot");
    expect(nextTool.description).toContain("project-later — added after snapshot");
    expect(nextTool.description).not.toContain("stable — initial definition");
    expect(nextTool.description).not.toContain("project-stable — initial project definition");
  });

  it("never exposes project agents when the project is untrusted", async () => {
    writeAgent(userAgentsDir, "user.md", "user", "global definition");
    writeAgent(projectAgentsDir, "project.md", "project", "local definition");
    const harness = createExtensionHarness(false);
    harness.startSession();
    const tool = harness.tools.at(-1);
    if (!tool) throw new Error("subagent tool was not registered");

    expect(tool.description).toContain("user — global definition");
    expect(tool.description).not.toContain("project — local definition");
    const listing = await executeTool(tool, {});
    expect(listing.content[0].text).toContain("user — global definition");
    expect(listing.content[0].text).not.toContain("project — local definition");
  });
});
