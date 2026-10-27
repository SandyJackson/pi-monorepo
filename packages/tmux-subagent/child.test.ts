import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS, startChildBridge } from "./child.ts";
import { type ChildRecord, createStore, type RequestRef, type Store } from "./store.ts";
import { createFakePi } from "./test-support.ts";

let root: string;
let store: Store;
let child: ChildRecord;
let fake: ReturnType<typeof createFakePi>;

beforeEach(() => {
  vi.useFakeTimers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-child-"));
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
  fake = createFakePi();
});

afterEach(async () => {
  await fake.emit("session_shutdown", { reason: "quit" });
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function ref(requestId: string): RequestRef {
  return { childId: child.childId, requestId };
}

function running(requestId: string, nonce: string) {
  return {
    version: 1 as const,
    request: ref(requestId),
    nonce,
    phase: "running" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function start(reason = "startup", nonce = "nonce-1"): Promise<void> {
  startChildBridge(fake.pi, {
    childDir: store.childDir(child.childId),
    nonce,
    ctx: fake.ctx,
    reason: reason as "startup",
  });
}

describe("child bridge startup", () => {
  it("marks a request left running by an earlier process interrupted and does not re-run it", async () => {
    store.createRequest(child.childId, "Old work");
    store.writeResult(running("r1", "old-nonce"));

    await start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(store.readResult(ref("r1"))).toMatchObject({
      phase: "settled",
      nonce: "nonce-1",
      result: { status: "failed", reason: "interrupted", humanIntervened: false },
    });
    expect(fake.sent).toEqual([]);
  });

  it("writes an idle status carrying the launch nonce as the readiness signal", async () => {
    await start();

    expect(store.readStatus(child.childId)).toEqual({
      version: 1,
      nonce: "nonce-1",
      pid: process.pid,
      state: "idle",
    });
  });

  it("keeps the same nonce across /reload, so status stays valid, and interrupts a request it lost track of", async () => {
    await start();
    store.createRequest(child.childId, "In flight");
    store.writeResult(running("r1", "nonce-1"));
    await fake.emit("session_shutdown", { reason: "reload" });
    fake = createFakePi();

    await start("reload");

    expect(store.readStatus(child.childId)).toMatchObject({ nonce: "nonce-1", state: "idle" });
    expect(store.readResult(ref("r1"))).toMatchObject({
      phase: "settled",
      result: { status: "failed", reason: "interrupted" },
    });
  });

  it("leaves a running result of the current process alone on a start other than reload", async () => {
    store.createRequest(child.childId, "Current");
    store.writeResult(running("r1", "nonce-1"));

    await start();

    expect(store.readResult(ref("r1"))).toMatchObject({ phase: "running" });
  });
});
