import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "./index.ts";
import { createStore } from "./store.ts";
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

  it("starts only the bridge, signalling readiness with the launch nonce", async () => {
    process.env.PI_SUBAGENT_NONCE = "launch-nonce";
    const { fake, store, childId } = childHarness();

    await fake.emit("session_start", { reason: "startup" });

    expect(fake.tools).toEqual([]);
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
