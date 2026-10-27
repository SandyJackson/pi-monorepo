import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLive, READY_MS } from "./launch.ts";
import { type ChildRecord, createStore, type Store } from "./store.ts";
import { createFakeTmux, type FakeSession } from "./test-support.ts";

let root: string;
let store: Store;
let child: ChildRecord;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-launch-"));
  store = createStore(path.join(root, "state"));
  child = store.createChild(
    {
      parent: { sessionId: "parent" },
      worktree: root,
      cwd: root,
      agent: { name: "scout", source: "user" },
      projectTrust: false,
      depth: 1,
      piCommand: ["/node", "/pi/cli.js"],
    },
    "",
  );
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The child bridge's readiness signal for the process started in `session`. */
function becomeReady(session: FakeSession, nonce = session.env.PI_SUBAGENT_NONCE): void {
  store.writeStatus(child.childId, { version: 1, nonce, pid: 1, state: "idle" });
}

describe("ensureLive", () => {
  it("starts the child on the private server and is live once its status carries the nonce", async () => {
    const tmux = createFakeTmux({ onNewSession: (session) => becomeReady(session) });

    const result = await ensureLive(child.childId, { store, tmux: tmux.exec });

    expect(result).toEqual({ status: "live", nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const session = tmux.sessions.get(`sa-${child.childId}`);
    expect(session?.env.PI_SUBAGENT_NONCE).toBe(result.status === "live" ? result.nonce : "");
    expect(session?.cwd).toBe(root);
    expect(session?.command.slice(0, 2)).toEqual(["/node", "/pi/cli.js"]);
    expect(session?.command).toContain("--no-approve");
    const newSession = tmux.calls.find((call) => call.includes("new-session"));
    expect(newSession?.slice(0, 2)).toEqual(["-f", path.join(root, "state", "tmux.conf")]);
    expect(fs.readFileSync(path.join(root, "state", "tmux.conf"), "utf8")).toContain(
      "set -g status off",
    );
  });

  it("creates one session and one Pi process for concurrent callers, who share its nonce", async () => {
    const tmux = createFakeTmux({ onNewSession: (session) => becomeReady(session) });

    const [first, second] = await Promise.all([
      ensureLive(child.childId, { store, tmux: tmux.exec }),
      ensureLive(child.childId, { store, tmux: tmux.exec }),
    ]);

    expect(tmux.calls.filter((call) => call.includes("new-session"))).toHaveLength(2);
    expect(tmux.launches).toBe(1);
    expect(first.status).toBe("live");
    expect(second).toEqual(first);
  });

  it("reads the nonce of an already-live child without launching", async () => {
    const tmux = createFakeTmux({ onNewSession: (session) => becomeReady(session) });
    const first = await ensureLive(child.childId, { store, tmux: tmux.exec });

    const again = await ensureLive(child.childId, { store, tmux: tmux.exec });

    expect(again).toEqual(first);
    expect(tmux.launches).toBe(1);
  });

  it("does not count a stale status from an earlier process as readiness", async () => {
    vi.useFakeTimers();
    const tmux = createFakeTmux({ onNewSession: (session) => becomeReady(session, "old-nonce") });

    const result = ensureLive(child.childId, { store, tmux: tmux.exec });
    await vi.advanceTimersByTimeAsync(READY_MS + 1000);

    await expect(result).resolves.toEqual({
      status: "indeterminate",
      error: expect.stringContaining("did not report readiness"),
    });
  });

  it("fails when the child exits before readiness", async () => {
    let tmux: ReturnType<typeof createFakeTmux> | undefined;
    tmux = createFakeTmux({ onNewSession: () => queueMicrotask(() => tmux?.kill(child.childId)) });

    const result = await ensureLive(child.childId, { store, tmux: tmux.exec });

    expect(result).toEqual({
      status: "failed",
      error: expect.stringContaining("exited before it was ready"),
    });
  });

  it("fails on any tmux refusal other than a duplicate session", async () => {
    const tmux = createFakeTmux({ newSessionError: "server exited unexpectedly" });

    await expect(ensureLive(child.childId, { store, tmux: tmux.exec })).resolves.toEqual({
      status: "failed",
      error: expect.stringContaining("server exited unexpectedly"),
    });
  });

  it("fails without launching when the child's cwd is not an existing directory", async () => {
    const tmux = createFakeTmux();
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "state", "children", child.childId), { recursive: true });
    fs.writeFileSync(
      path.join(root, "state", "children", child.childId, "child.json"),
      JSON.stringify({ ...child, cwd: path.join(root, "gone") }),
    );

    const result = await ensureLive(child.childId, { store, tmux: tmux.exec });

    expect(result).toEqual({ status: "failed", error: expect.stringContaining("gone") });
    expect(tmux.launches).toBe(0);
  });
});
