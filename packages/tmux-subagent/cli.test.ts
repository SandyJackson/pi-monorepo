import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliDeps, runCli } from "./cli.ts";
import { type ChildRecord, createStore, type NewChild, type Store } from "./store.ts";
import { createFakeTmux } from "./test-support.ts";

let root: string;
let worktree: string;
let store: Store;
let privateTmux: ReturnType<typeof createFakeTmux>;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-cli-")));
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
      parent: { sessionId: "0123456789abcdef-parent" },
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

/** Give a child a live session on the scripted private server, launched with `nonce`. */
function liven(child: ChildRecord, nonce: string): void {
  privateTmux.sessions.set(`sa-${child.childId}`, {
    name: `sa-${child.childId}`,
    cwd: child.cwd,
    env: { PI_SUBAGENT_NONCE: nonce },
    command: [],
  });
}

function run(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const deps: CliDeps = {
    store,
    tmux: privateTmux.exec,
    socket: "pi-subagents-test",
    cwd: worktree,
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  return runCli(argv, deps).then((code) => ({ code, stdout, stderr }));
}

async function listJson(argv: string[] = []) {
  const result = await run(["list", "--json", ...argv]);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}

describe("list", () => {
  it("groups the worktree's children by parent, titled by name or short session ID", async () => {
    const first = addChild({ parent: { sessionId: "aaaaaaaa-1111", name: "planning" } });
    const second = addChild({
      parent: { sessionId: "bbbbbbbb-2222" },
      agent: { name: "reviewer", source: "workspace" },
      label: "review the diff",
    });
    const third = addChild({ parent: { sessionId: "aaaaaaaa-1111", name: "planning" } });

    const listing = await listJson();

    expect(listing).toEqual({
      worktree,
      groups: [
        {
          title: "planning",
          children: [
            { childId: first.childId, agent: "scout", state: "stopped" },
            { childId: third.childId, agent: "scout", state: "stopped" },
          ],
        },
        {
          title: "bbbbbbbb",
          children: [
            {
              childId: second.childId,
              agent: "reviewer",
              label: "review the diff",
              state: "stopped",
            },
          ],
        },
      ],
    });
  });

  it("lists grandchildren under their creating child and leaves out other worktrees", async () => {
    const elsewhere = path.join(root, "other");
    fs.mkdirSync(elsewhere);
    const reviewer = addChild({
      parent: { sessionId: "aaaaaaaa-1111", name: "planning" },
      agent: { name: "reviewer", source: "workspace" },
    });
    addChild({ worktree: elsewhere, cwd: elsewhere });
    const scout = addChild({ parent: { sessionId: "aaaaaaaa-1111", name: "planning" } });
    const grandchild = addChild({
      parent: { sessionId: reviewer.childId },
      depth: 2,
      label: "check tests",
    });

    const listing = await listJson();

    expect(listing.groups).toEqual([
      {
        title: "planning",
        children: [
          { childId: reviewer.childId, agent: "reviewer", state: "stopped" },
          { childId: scout.childId, agent: "scout", state: "stopped" },
        ],
      },
      {
        title: `child ${reviewer.childId}`,
        children: [
          { childId: grandchild.childId, agent: "scout", label: "check tests", state: "stopped" },
        ],
      },
    ]);
  });

  it("shows each child's state from its live session and current status", async () => {
    const idle = addChild();
    const running = addChild();
    const blocked = addChild();
    const starting = addChild();
    const stale = addChild();
    for (const child of [idle, running, blocked, starting, stale]) liven(child, "n1");
    store.writeStatus(idle.childId, { version: 1, nonce: "n1", pid: 1, state: "idle" });
    store.writeStatus(running.childId, {
      version: 1,
      nonce: "n1",
      pid: 1,
      state: "running",
      current: "r1",
    });
    store.writeStatus(blocked.childId, {
      version: 1,
      nonce: "n1",
      pid: 1,
      state: "running",
      blocked: { label: "bash permission", since: "2026-10-27T00:00:00Z" },
    });
    store.writeStatus(stale.childId, { version: 1, nonce: "old", pid: 1, state: "idle" });

    const listing = await listJson();

    const states = Object.fromEntries(
      listing.groups[0].children.map((child: { childId: string; state: string }) => [
        child.childId,
        child.state,
      ]),
    );
    // A live session without a current status is a Pi process still starting.
    expect(states).toEqual({
      [idle.childId]: "idle",
      [running.childId]: "running",
      [blocked.childId]: "blocked",
      [starting.childId]: "running",
      [stale.childId]: "running",
    });
    expect(privateTmux.launches).toBe(0);
  });

  it("prints a readable listing without --json", async () => {
    const child = addChild({
      parent: { sessionId: "aaaaaaaa-1111", name: "planning" },
      label: "map",
    });

    const result = await run(["list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`planning\n  ${child.childId}  scout  stopped  map\n`);
  });

  it("says so when the worktree has no children", async () => {
    const result = await run(["list"]);

    expect(result.stdout).toBe("No subagents for this worktree\n");
  });

  it("resolves --worktree from a subdirectory through Git's top level", async () => {
    execFileSync("git", ["init", "-q", worktree]);
    const nested = path.join(worktree, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });
    const child = addChild();

    const listing = await listJson(["--worktree", nested]);

    expect(listing.worktree).toBe(worktree);
    expect(listing.groups[0].children[0].childId).toBe(child.childId);
  });

  it("skips a child whose record cannot be read, naming it on stderr, and lists the rest", async () => {
    const child = addChild();
    // A child directory whose child.json was never written (createChild failed, or is mid-write).
    fs.mkdirSync(path.join(store.root, "children", "scout-abcd"), { recursive: true });

    const result = await run(["list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(child.childId);
    expect(result.stderr).toMatch(/^Skipped child scout-abcd: .+\n$/);
  });

  it("errors on an unresolvable worktree and lists nothing", async () => {
    addChild();

    const result = await run(["list", "--worktree", path.join(root, "missing")]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot resolve the worktree");
  });
});

describe("running under node", () => {
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

  it("loads only its own inspection, state, tmux, launch, and text modules, never Pi", () => {
    const script = `
      import { registerHooks } from "node:module";
      const loaded = [];
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        loaded.push(result.url);
        return result;
      } });
      await import(${JSON.stringify(pathToFileURL(cliPath).href)});
      console.log(JSON.stringify(loaded));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });

    const local = (JSON.parse(output) as string[])
      .filter((url) => !url.startsWith("node:"))
      .map((url) => path.basename(fileURLToPath(url)));
    expect([...new Set(local)].sort()).toEqual([
      "cli.ts",
      "inspect.ts",
      "launch.ts",
      "model-text.ts",
      "store.ts",
      "tmux.ts",
    ]);
  });

  it("runs directly, finding the store through Pi's agent directory", () => {
    // No child in this worktree, so no tmux command runs.
    addChild({ worktree: root, cwd: root });
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir);
    fs.symlinkSync(store.root, path.join(agentDir, "subagents"));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
    delete env.TMUX;
    delete env.TMUX_PANE;

    const output = execFileSync(process.execPath, [cliPath, "list", "--worktree", worktree], {
      encoding: "utf8",
      env,
    });

    expect(output).toBe("No subagents for this worktree\n");
  });
});

describe("stop", () => {
  it("ends one child's session and keeps its records and transcript", async () => {
    const child = addChild();
    const other = addChild();
    liven(child, "n1");
    liven(other, "n2");
    const transcript = path.join(store.childDir(child.childId), "session", "t.jsonl");
    fs.writeFileSync(transcript, "{}\n");

    const result = await run(["stop", child.childId]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Stopped ${child.childId}\n`);
    expect([...privateTmux.sessions.keys()]).toEqual([`sa-${other.childId}`]);
    expect(store.readChild(child.childId).childId).toBe(child.childId);
    expect(fs.existsSync(transcript)).toBe(true);
  });

  it("ends every live child of a worktree, grandchildren included, and no others", async () => {
    const elsewhere = path.join(root, "other");
    fs.mkdirSync(elsewhere);
    const first = addChild();
    const grandchild = addChild({ parent: { sessionId: first.childId }, depth: 2 });
    const stopped = addChild();
    const unrelated = addChild({ worktree: elsewhere, cwd: elsewhere });
    for (const child of [first, grandchild, unrelated]) liven(child, "n1");

    const result = await run(["stop", "--worktree", worktree]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Stopped ${first.childId}\nStopped ${grandchild.childId}\n`);
    expect([...privateTmux.sessions.keys()]).toEqual([`sa-${unrelated.childId}`]);
    expect(store.readChild(stopped.childId).childId).toBe(stopped.childId);
  });

  it("stops a worktree's readable children when another child's record cannot be read", async () => {
    const child = addChild();
    liven(child, "n1");
    fs.mkdirSync(path.join(store.root, "children", "scout-abcd"), { recursive: true });

    const result = await run(["stop", "--worktree", worktree]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Stopped ${child.childId}\n`);
    expect(result.stderr).toMatch(/^Skipped child scout-abcd: /);
  });

  it("succeeds without change for a child that is already stopped", async () => {
    const child = addChild();

    const result = await run(["stop", child.childId]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${child.childId} is not running\n`);
  });

  it("needs exactly one of a child ID or --worktree", async () => {
    const child = addChild();

    expect((await run(["stop"])).code).toBe(2);
    expect((await run(["stop", child.childId, "--worktree", worktree])).code).toBe(2);
  });
});
