import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliDeps, runCli } from "./cli.ts";
import { READY_MS } from "./launch.ts";
import { type ChildRecord, createStore, type NewChild, type Store } from "./store.ts";
import { createFakeTmux } from "./test-support.ts";
import type { TmuxExec } from "./tmux.ts";

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

/** A scripted operator tmux server: panes have a current path; commands are recorded. */
function createFakeOuter(panes: Record<string, string> = {}) {
  const calls: string[][] = [];
  const responses: Array<(args: readonly string[]) => Awaited<ReturnType<TmuxExec>> | undefined> =
    [];
  const exec: TmuxExec = async (args) => {
    calls.push([...args]);
    for (const respond of responses) {
      const result = respond(args);
      if (result) return result;
    }
    if (args[0] === "display-message" && args.includes("-p")) {
      const pane = args[args.indexOf("-t") + 1];
      if (!(pane in panes)) return { code: 1, stdout: "", stderr: `can't find pane: ${pane}\n` };
      return { code: 0, stdout: `${panes[pane]}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, responses };
}

function run(argv: string[], outer = createFakeOuter()) {
  let stdout = "";
  let stderr = "";
  const deps: CliDeps = {
    store,
    tmux: privateTmux.exec,
    outer: outer.exec,
    socket: "pi-subagents-test",
    cliCommand: ["/bin/node", "/pkg/cli.ts"],
    cwd: worktree,
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  return runCli(argv, deps).then((code) => ({ code, stdout, stderr, outer }));
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

  it("errors on an unresolvable worktree and lists nothing", async () => {
    addChild();

    const result = await run(["list", "--worktree", path.join(root, "missing")]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot resolve the worktree");
  });
});

function menuCall(outer: ReturnType<typeof createFakeOuter>) {
  return outer.calls.find((call) => call[0] === "display-menu");
}

function messages(outer: ReturnType<typeof createFakeOuter>) {
  return outer.calls.filter((call) => call[0] === "display-message" && !call.includes("-p"));
}

describe("pick", () => {
  it("shows a menu on the pane's window, one titled group per parent, each item opening its child", async () => {
    const reviewer = addChild({
      parent: { sessionId: "aaaaaaaa-1111", name: "planning" },
      agent: { name: "reviewer", source: "workspace" },
      label: "review",
    });
    const scout = addChild({ parent: { sessionId: "bbbbbbbb-2222" } });
    const grandchild = addChild({ parent: { sessionId: reviewer.childId }, depth: 2 });
    const outer = createFakeOuter({ "%3": path.join(worktree, "src") });
    fs.mkdirSync(path.join(worktree, "src"));
    execFileSync("git", ["init", "-q", worktree]);

    const result = await run(["pick", "--pane", "%3"], outer);

    expect(result.code).toBe(0);
    const open = (childId: string) =>
      `run-shell -b '"/bin/node" "/pkg/cli.ts" open ${childId} --pane %3'`;
    expect(menuCall(outer)).toEqual([
      "display-menu",
      "-t",
      "%3",
      "-T",
      "Subagents",
      "-x",
      "C",
      "-y",
      "C",
      "--",
      "-planning",
      "",
      "",
      `${reviewer.childId}  reviewer  stopped  review`,
      "1",
      open(reviewer.childId),
      "",
      `-child ${reviewer.childId}`,
      "",
      "",
      `${grandchild.childId}  scout  stopped`,
      "2",
      open(grandchild.childId),
      "",
      "-bbbbbbbb",
      "",
      "",
      `${scout.childId}  scout  stopped`,
      "3",
      open(scout.childId),
    ]);
  });

  it("shows an empty menu when the worktree has no children", async () => {
    const elsewhere = path.join(root, "other");
    fs.mkdirSync(elsewhere);
    addChild({ worktree: elsewhere, cwd: elsewhere });
    const outer = createFakeOuter({ "%3": worktree });

    const result = await run(["pick", "--pane", "%3"], outer);

    expect(result.code).toBe(0);
    expect(menuCall(outer)?.slice(10)).toEqual(["-No subagents for this worktree", "", ""]);
  });

  it("quotes paths and user text for tmux, the shell, and tmux formats", async () => {
    const child = addChild({ label: `fix #12 \u001b[31m${"x".repeat(60)}` });
    const outer = createFakeOuter({ "%3": worktree });

    let stdout = "";
    const result = await runCli(["pick", "--pane", "%3"], {
      store,
      tmux: privateTmux.exec,
      outer: outer.exec,
      socket: "pi-subagents-test",
      cliCommand: ["/bin/node", "/pkg dir/$x#y/cli.ts"],
      cwd: worktree,
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });

    expect(result).toBe(0);
    expect(stdout).toBe("");
    const menu = menuCall(outer) ?? [];
    expect(menu.slice(13)).toEqual([
      `${child.childId}  scout  stopped  fix ##12 [31m${"x".repeat(27)}…`,
      "1",
      `run-shell -b '"/bin/node" "/pkg dir/\\$x##y/cli.ts" open ${child.childId} --pane %3'`,
    ]);
  });

  it("shows an error on the pane and no menu when the pane's worktree cannot be resolved", async () => {
    addChild();
    const outer = createFakeOuter({ "%3": "" });

    const result = await run(["pick", "--pane", "%3"], outer);

    expect(result.code).toBe(1);
    expect(menuCall(outer)).toBeUndefined();
    expect(messages(outer)).toEqual([
      ["display-message", "-t", "%3", 'Subagents: Cannot resolve the worktree of "".'],
    ]);
  });

  it("shows an error when the pane does not exist", async () => {
    const outer = createFakeOuter({});

    const result = await run(["pick", "--pane", "%9"], outer);

    expect(result.code).toBe(1);
    expect(menuCall(outer)).toBeUndefined();
    expect(result.stderr).toContain("can't find pane: %9");
  });

  it("rejects a pane that is not a tmux pane ID", async () => {
    const result = await run(["pick", "--pane", "%3; kill-server"]);

    expect(result.code).toBe(2);
    expect(result.outer.calls).toEqual([]);
  });
});

describe("open", () => {
  function attachArgs(childId: string) {
    return [
      "new-pane",
      "-O",
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

  it("resumes a stopped child, then floats an attach client over the pane, keeping drain", async () => {
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
    const outer = createFakeOuter();

    const result = await run(["open", child.childId, "--pane", "%3"], outer);

    expect(result.code).toBe(0);
    expect(privateTmux.launches).toBe(1);
    expect(outer.calls).toEqual([attachArgs(child.childId)]);
    expect(fs.existsSync(drain)).toBe(true);
  });

  it("attaches to a live child without launching it", async () => {
    const child = addChild();
    liven(child, "n1");
    store.writeStatus(child.childId, { version: 1, nonce: "n1", pid: 1, state: "running" });
    const outer = createFakeOuter();

    const result = await run(["open", child.childId, "--pane", "%3"], outer);

    expect(result.code).toBe(0);
    expect(privateTmux.launches).toBe(0);
    expect(outer.calls).toEqual([attachArgs(child.childId)]);
  });

  it("shows tmux's refusal when the window already has a float, and does nothing else", async () => {
    const child = addChild();
    liven(child, "n1");
    store.writeStatus(child.childId, { version: 1, nonce: "n1", pid: 1, state: "idle" });
    const outer = createFakeOuter();
    outer.responses.push((args) =>
      args[0] === "new-pane"
        ? { code: 1, stdout: "", stderr: "window already has a modal pane\n" }
        : undefined,
    );

    const result = await run(["open", child.childId, "--pane", "%3"], outer);

    expect(result.code).toBe(1);
    expect(outer.calls.map((call) => call[0])).toEqual(["new-pane", "display-message"]);
    expect(messages(outer)[0].at(-1)).toContain("window already has a modal pane");
  });

  it("shows the launch failure and opens no float when the child cannot be resumed", async () => {
    const gone = path.join(root, "gone");
    fs.mkdirSync(gone);
    const child = addChild({ cwd: gone });
    fs.rmdirSync(gone);
    const outer = createFakeOuter();

    const result = await run(["open", child.childId, "--pane", "%3"], outer);

    expect(result.code).toBe(1);
    expect(privateTmux.launches).toBe(0);
    expect(outer.calls.map((call) => call[0])).toEqual(["display-message"]);
    expect(messages(outer)[0].at(-1)).toContain("is not an existing directory");
  });

  it("still floats a live child that has not reported readiness, so the operator can see why", async () => {
    const child = addChild();
    liven(child, "n1");
    const outer = createFakeOuter();
    vi.useFakeTimers();
    try {
      const pending = run(["open", child.childId, "--pane", "%3"], outer);
      await vi.advanceTimersByTimeAsync(READY_MS + 1000);
      const result = await pending;

      expect(result.code).toBe(0);
      expect(outer.calls).toEqual([attachArgs(child.childId)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an error for a child that does not exist", async () => {
    const outer = createFakeOuter();

    const result = await run(["open", "scout-zzzz", "--pane", "%3"], outer);

    expect(result.code).toBe(1);
    expect(messages(outer)[0].at(-1)).toBe("Subagents: Child scout-zzzz does not exist.");
  });
});

describe("running under node", () => {
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

  it("loads only its own state, tmux, and launch modules, never Pi", () => {
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
    expect([...new Set(local)].sort()).toEqual(["cli.ts", "launch.ts", "store.ts", "tmux.ts"]);
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
