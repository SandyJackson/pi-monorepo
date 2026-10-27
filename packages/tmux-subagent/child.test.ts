import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HERDR_BLOCKED_EVENT } from "@pi-workspace/herdr-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISPATCH_MS, POLL_MS, startChildBridge } from "./child.ts";
import { type ChildRecord, createStore, type RequestRef, type Store } from "./store.ts";
import { assistantEntry, createFakePi, userEntry } from "./test-support.ts";

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

/** Pi receiving the dispatched instruction while idle: `input`, then a run starts. */
async function piStartsRun(text: string): Promise<void> {
  await fake.emit("input", { text, source: "extension" });
  fake.state.idle = false;
  await fake.emit("agent_start");
}

/** The run persists the request and its answer, then settles. */
async function piCompletesRun(text: string, answer: string, suffix = "1"): Promise<void> {
  fake.append(userEntry(`u${suffix}`, text));
  fake.append(assistantEntry(`a${suffix}`, answer));
  await fake.emit("agent_before_settle", { outcome: "completed" });
  fake.state.idle = true;
  await fake.emit("agent_settled", { aborted: false });
}

async function nextPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS);
}

describe("child bridge dispatch and settlement", () => {
  beforeEach(() => {
    fake.append(assistantEntry("a0", "Before the request"));
  });

  it("dispatches the lowest queued request as a follow-up and records its answer", async () => {
    store.createRequest(child.childId, "Review the diff");
    await start();

    await nextPoll();
    expect(fake.sent).toEqual([{ text: "Review the diff", deliverAs: "followUp" }]);
    expect(store.readResult(ref("r1"))).toBeUndefined();

    await piStartsRun("Review the diff");
    expect(store.readResult(ref("r1"))).toMatchObject({ phase: "running", nonce: "nonce-1" });
    expect(store.readStatus(child.childId)).toMatchObject({ state: "running", current: "r1" });

    await piCompletesRun("Review the diff", "Looks good");
    expect(store.readResult(ref("r1"))).toMatchObject({
      phase: "settled",
      result: {
        status: "completed",
        answer: { path: fake.state.sessionFile, entryId: "a1" },
        humanIntervened: false,
      },
    });
    expect(store.readStatus(child.childId)).toEqual({
      version: 1,
      nonce: "nonce-1",
      pid: process.pid,
      state: "idle",
    });
  });

  it("dispatches requests one at a time, in order", async () => {
    store.createRequest(child.childId, "First");
    store.createRequest(child.childId, "Second");
    await start();

    await nextPoll();
    await piStartsRun("First");
    await nextPoll();
    expect(fake.sent.map((sent) => sent.text)).toEqual(["First"]);

    await piCompletesRun("First", "One");
    await nextPoll();
    expect(fake.sent.map((sent) => sent.text)).toEqual(["First", "Second"]);
  });

  it("waits while Pi is busy, has pending messages, or shows a UI prompt", async () => {
    store.createRequest(child.childId, "Later");
    await start();

    fake.state.idle = false;
    await nextPoll();
    fake.state.idle = true;
    fake.state.pendingMessages = true;
    await nextPoll();
    fake.state.pendingMessages = false;
    await fake.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" });
    await nextPoll();
    expect(fake.sent).toEqual([]);

    await fake.emit("ui_prompt_end", { reason: "ui_prompt", kind: "confirm" });
    await nextPoll();
    expect(fake.sent).toHaveLength(1);
  });

  it("confirms a request queued behind a run through the input's streaming behaviour", async () => {
    store.createRequest(child.childId, "Queued");
    await start();
    await nextPoll();

    await fake.emit("input", {
      text: "Queued",
      source: "extension",
      streamingBehavior: "followUp",
    });

    expect(store.readResult(ref("r1"))).toMatchObject({ phase: "running" });
  });

  it.each([
    { name: "input consumed or authentication missing", input: true },
    { name: "no input event at all", input: false },
  ])(
    "settles failed/error when Pi does not start the request ($name) and never resends it",
    async ({ input }) => {
      store.createRequest(child.childId, "Never starts");
      await start();
      await nextPoll();
      if (input) await fake.emit("input", { text: "Never starts", source: "extension" });

      await vi.advanceTimersByTimeAsync(DISPATCH_MS);
      await vi.advanceTimersByTimeAsync(POLL_MS * 4);

      expect(store.readResult(ref("r1"))).toMatchObject({
        phase: "settled",
        result: { status: "failed", reason: "error", error: "Pi did not start the request" },
      });
      expect(fake.sent).toHaveLength(1);
      expect(store.readStatus(child.childId)).toMatchObject({ state: "idle" });
    },
  );

  it("does not confirm on another input or on a run that started without the request's input", async () => {
    store.createRequest(child.childId, "Mine");
    await start();
    await nextPoll();

    await fake.emit("input", { text: "Something else", source: "extension" });
    await fake.emit("agent_start");

    expect(store.readResult(ref("r1"))).toBeUndefined();
  });

  it("records superseded when the request entry is not on the branch at settlement", async () => {
    store.createRequest(child.childId, "Moved away");
    await start();
    await nextPoll();
    await piStartsRun("Moved away");

    await fake.emit("agent_before_settle", { outcome: "completed" });
    await fake.emit("agent_settled", { aborted: false });

    expect(store.readResult(ref("r1"))).toMatchObject({
      phase: "settled",
      result: { status: "failed", reason: "superseded" },
    });
  });

  it("records interrupted when the run is aborted, even though Pi skips agent_before_settle", async () => {
    store.createRequest(child.childId, "Escape me");
    await start();
    await nextPoll();
    await piStartsRun("Escape me");
    fake.append(userEntry("u1", "Escape me"));

    await fake.emit("agent_settled", { aborted: true });

    expect(store.readResult(ref("r1"))).toMatchObject({
      result: { status: "failed", reason: "interrupted" },
    });
  });

  it("records error for an error outcome", async () => {
    store.createRequest(child.childId, "Break");
    await start();
    await nextPoll();
    await piStartsRun("Break");
    fake.append(userEntry("u1", "Break"));

    await fake.emit("agent_before_settle", { outcome: "error" });
    await fake.emit("agent_settled", { aborted: false });

    expect(store.readResult(ref("r1"))).toMatchObject({
      result: { status: "failed", reason: "error" },
    });
  });

  it("does not carry an outcome over from an earlier run", async () => {
    await start();
    await fake.emit("agent_start");
    await fake.emit("agent_before_settle", { outcome: "completed" });
    await fake.emit("agent_settled", { aborted: false });
    store.createRequest(child.childId, "No outcome");
    await nextPoll();
    await piStartsRun("No outcome");
    fake.append(userEntry("u1", "No outcome"));

    await fake.emit("agent_settled", { aborted: false });

    expect(store.readResult(ref("r1"))).toMatchObject({
      result: { status: "failed", reason: "error", error: "Pi settled without an outcome" },
    });
  });

  it("marks operator input during the request and returns the latest answer", async () => {
    store.createRequest(child.childId, "Review");
    await start();
    await nextPoll();
    await piStartsRun("Review");
    fake.append(userEntry("u1", "Review"));
    fake.append(assistantEntry("a1", "First answer"));

    await fake.emit("input", { text: "Also check tests", source: "interactive" });
    await piCompletesRun("Also check tests", "Updated answer", "2");

    expect(store.readResult(ref("r1"))).toMatchObject({
      result: {
        status: "completed",
        answer: { entryId: "a2" },
        humanIntervened: true,
      },
    });
  });

  it("records the blocked state from UI prompts and the herdr:blocked event", async () => {
    await start();

    await fake.emit("ui_prompt_start", { reason: "ui_prompt", kind: "select", title: "Pick" });
    expect(store.readStatus(child.childId)?.blocked).toEqual({
      label: "Pick",
      since: expect.any(String),
    });
    await fake.emit("ui_prompt_end", { reason: "ui_prompt", kind: "select" });
    expect(store.readStatus(child.childId)?.blocked).toBeUndefined();

    fake.pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: "Bash permission: waiting" });
    expect(store.readStatus(child.childId)?.blocked?.label).toBe("Bash permission: waiting");
    fake.pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
    expect(store.readStatus(child.childId)?.blocked).toBeUndefined();
  });
});
