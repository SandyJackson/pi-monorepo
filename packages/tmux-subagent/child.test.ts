import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HERDR_BLOCKED_EVENT } from "@pi-workspace/herdr-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReportTool,
  DISPATCH_MS,
  POLL_MS,
  startChildBridge,
  UNVIEWED_EXIT_MS,
} from "./child.ts";
import { type ChildRecord, createStore, type RequestRef, type Store } from "./store.ts";
import { assistantEntry, createFakePi, createFakeTmux, userEntry } from "./test-support.ts";

let root: string;
let store: Store;
let child: ChildRecord;
let fake: ReturnType<typeof createFakePi>;
let tmux: ReturnType<typeof createFakeTmux>;

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
  tmux = createFakeTmux();
  const session = `sa-${child.childId}`;
  tmux.sessions.set(session, { name: session, cwd: root, env: {}, command: [] });
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
    tmux: tmux.exec,
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

/**
 * Pi receiving the dispatched instruction while idle: `input`, then a run
 * starts with `prompt`, the text after skill and template expansion.
 */
async function piStartsRun(text: string, prompt = text): Promise<void> {
  await fake.emit("input", { text, source: "extension" });
  fake.state.idle = false;
  await fake.emit("before_agent_start", { messageType: "user", prompt });
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
    expect(fake.sent).toEqual([
      { text: "Review the diff", deliverAs: "followUp", expandPromptTemplates: true },
    ]);
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

  it("settles an unreadable request as failed without sending it, then dispatches the next", async () => {
    store.createRequest(child.childId, "Corrupt");
    store.createRequest(child.childId, "Second");
    fs.writeFileSync(
      path.join(store.childDir(child.childId), "requests", "r1", "request.json"),
      "{",
    );
    await start();

    await nextPoll();
    expect(store.readResult(ref("r1"))).toMatchObject({
      phase: "settled",
      result: {
        status: "failed",
        reason: "error",
        error: expect.stringContaining("request.json"),
        humanIntervened: false,
      },
    });
    await nextPoll();
    expect(fake.sent.map((sent) => sent.text)).toEqual(["Second"]);
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

  it("expands a delegated skill instruction and binds the expanded request entry", async () => {
    const instruction = "/skill:review mode=quick";
    const expanded =
      '<skill name="review" location="/skills/review/SKILL.md">\nReview.\n</skill>\n\nmode=quick';
    store.createRequest(child.childId, instruction);
    await start();
    await nextPoll();
    expect(fake.sent).toEqual([
      { text: instruction, deliverAs: "followUp", expandPromptTemplates: true },
    ]);

    await piStartsRun(instruction, expanded);
    await piCompletesRun(expanded, "Reviewed");

    expect(store.readResult(ref("r1"))).toMatchObject({
      phase: "settled",
      result: { status: "completed", answer: { entryId: "a1" } },
    });
  });

  it("takes back a request that reaches Pi while a run is streaming and dispatches it again when idle", async () => {
    store.createRequest(child.childId, "Raced");
    await start();
    await nextPoll();

    // The operator started a run between the idle check and the input.
    fake.state.idle = false;
    const results = await fake.emit("input", {
      text: "Raced",
      source: "extension",
      streamingBehavior: "followUp",
    });

    expect(results).toContainEqual({ action: "handled" });
    await vi.advanceTimersByTimeAsync(DISPATCH_MS * 2);
    expect(store.readResult(ref("r1"))).toBeUndefined();
    expect(fake.sent).toHaveLength(1);

    fake.state.idle = true;
    await nextPoll();
    expect(fake.sent.map((sent) => sent.text)).toEqual(["Raced", "Raced"]);
    await piStartsRun("Raced");
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

describe("subagent_report", () => {
  async function report(params: Record<string, unknown>): Promise<string> {
    const tool = createReportTool({ store, childId: child.childId });
    const result = await tool.execute(
      "call",
      params as { content: string },
      undefined,
      undefined,
      fake.ctx,
    );
    return (result.content[0] as { text: string }).text;
  }

  it("queues a report for the parent named in child.json, taking identity only from the record", async () => {
    // Fields the model might add do not reach the record.
    const text = await report({
      content: "Found a second bug",
      childId: "other-aaaa",
      parentSessionId: "someone-else",
      reportId: "m9",
      agent: "admin",
    });

    expect(text).toBe("Report m1 queued for the parent");
    expect(store.readReport(child.childId, "m1")).toMatchObject({
      childId: child.childId,
      reportId: "m1",
      parentSessionId: "parent",
      agent: "scout",
      content: "Found a second bug",
    });
    expect(await report({ content: "And a third" })).toBe("Report m2 queued for the parent");
  });

  it("has a strict schema and refuses empty content", async () => {
    const tool = createReportTool({ store, childId: child.childId });
    expect(tool.name).toBe("subagent_report");
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
      required: ["content"],
      properties: { content: { type: "string", minLength: 1 } },
    });
    expect(tool.description).toContain(
      "For an initial delegated task, finish the assigned work before sending a report.",
    );

    await expect(report({ content: "  \n " })).rejects.toThrow(/empty/);
    expect(store.listReportIds(child.childId)).toEqual([]);
  });
});

describe("child bridge drain", () => {
  function drain(): void {
    store.writeDrain(child.childId);
  }

  it("exits promptly when drain appears while idle and unattached", async () => {
    await start();
    await nextPoll();
    expect(fake.state.shutdowns).toBe(0);

    drain();
    await nextPoll();

    expect(fake.state.shutdowns).toBe(1);
    expect(tmux.calls).toContainEqual([
      "display-message",
      "-p",
      "-t",
      `=sa-${child.childId}:`,
      "#{session_attached}",
    ]);
  });

  it("never exits at startup, even with drain present and no client attached", async () => {
    drain();
    await start();

    await vi.advanceTimersByTimeAsync(UNVIEWED_EXIT_MS - POLL_MS);

    expect(fake.state.shutdowns).toBe(0);
  });

  it("finishes the running request and the queued follow-up before exiting", async () => {
    fake.append(assistantEntry("a0", "Before"));
    store.createRequest(child.childId, "First");
    store.createRequest(child.childId, "Second");
    await start();
    await nextPoll();
    await piStartsRun("First");

    drain();
    await nextPoll();
    expect(fake.state.shutdowns).toBe(0);

    await piCompletesRun("First", "One");
    await nextPoll();
    expect(fake.state.shutdowns).toBe(0);
    expect(fake.sent.map((sent) => sent.text)).toEqual(["First", "Second"]);

    await piStartsRun("Second");
    await piCompletesRun("Second", "Two", "2");
    await nextPoll();

    expect(store.readResult(ref("r2"))).toMatchObject({ phase: "settled" });
    expect(fake.state.shutdowns).toBe(1);
  });

  it("stays while Pi has pending messages after a run settles", async () => {
    await start();
    drain();
    fake.state.idle = false;
    await nextPoll();

    fake.state.idle = true;
    fake.state.pendingMessages = true;
    await fake.emit("agent_settled", { aborted: false });
    await nextPoll();

    expect(fake.state.shutdowns).toBe(0);
  });

  it("stays while blocked on a UI prompt", async () => {
    await start();
    await fake.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" });

    drain();
    await vi.advanceTimersByTimeAsync(POLL_MS * 8);

    expect(fake.state.shutdowns).toBe(0);
  });

  it("stays while viewed and exits after the last viewer detaches", async () => {
    tmux.setAttached(child.childId, "2");
    await start();
    drain();
    await nextPoll();

    tmux.setAttached(child.childId, "1");
    await nextPoll();
    expect(fake.state.shutdowns).toBe(0);

    tmux.setAttached(child.childId, "0");
    await nextPoll();
    expect(fake.state.shutdowns).toBe(1);
  });

  it.each([
    { name: "empty output", output: "" },
    { name: "non-integer output", output: "zero" },
  ])("treats $name from tmux as attached", async ({ output }) => {
    tmux.setAttached(child.childId, output);
    await start();

    drain();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(fake.state.shutdowns).toBe(0);
  });

  it("exits an inspection-only resume that nobody attaches to within 60 s", async () => {
    drain();
    await start();

    await vi.advanceTimersByTimeAsync(UNVIEWED_EXIT_MS - POLL_MS);
    expect(fake.state.shutdowns).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(fake.state.shutdowns).toBe(1);
  });

  it("keeps an inspection-only resume while viewed past 60 s, then exits on detach", async () => {
    drain();
    tmux.setAttached(child.childId, "1");
    await start();

    await vi.advanceTimersByTimeAsync(UNVIEWED_EXIT_MS * 2);
    expect(fake.state.shutdowns).toBe(0);

    tmux.setAttached(child.childId, "0");
    await nextPoll();
    expect(fake.state.shutdowns).toBe(1);
  });

  it("stays when the parent returns and deletes drain", async () => {
    drain();
    await start();
    store.removeDrain(child.childId);

    await vi.advanceTimersByTimeAsync(UNVIEWED_EXIT_MS * 2);

    expect(fake.state.shutdowns).toBe(0);
  });
});
