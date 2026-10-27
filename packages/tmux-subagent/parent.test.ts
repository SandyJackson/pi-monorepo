import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents.ts";
import { createParentRuntime, type DelegatedTaskRecord, POLL_MS } from "./parent.ts";
import { createStore, type RequestRef, type RequestResult, type Store } from "./store.ts";
import { createFakeTmux, type FakeSession } from "./test-support.ts";

let root: string;
let parentCwd: string;
let store: Store;

beforeEach(() => {
  vi.useFakeTimers();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-parent-")));
  parentCwd = path.join(root, "project");
  fs.mkdirSync(path.join(parentCwd, "pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, "elsewhere"));
  store = createStore(path.join(root, "state"));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

const scout: AgentConfig = {
  name: "scout",
  description: "Scout",
  tools: ["read"],
  model: "mock/echo",
  timeout: 5,
  systemPromptBody: "You scout.",
  source: "user",
  sourceDir: "/agents",
  filePath: "/agents/scout.md",
};

function task(
  taskNumber: number,
  overrides: Partial<DelegatedTaskRecord> = {},
): DelegatedTaskRecord {
  return {
    taskNumber,
    agent: "scout",
    instruction: `Task ${taskNumber}`,
    cwd: parentCwd,
    config: scout,
    timeoutMs: 60_000,
    ...overrides,
  };
}

function childIdOf(session: FakeSession): string {
  return session.name.slice("sa-".length);
}

/** The child bridge becoming ready in a launched session. */
function ready(session: FakeSession): void {
  store.writeStatus(childIdOf(session), {
    version: 1,
    nonce: session.env.PI_SUBAGENT_NONCE,
    pid: 1,
    state: "idle",
  });
}

function settle(request: RequestRef, result: RequestResult): void {
  store.writeResult({
    version: 1,
    request,
    nonce: "n",
    phase: "settled",
    settledAt: "2026-01-01T00:00:00.000Z",
    result,
  });
}

function runtime(tmux: ReturnType<typeof createFakeTmux>, trusted = true) {
  return createParentRuntime({
    parentSessionId: "parent-session",
    parentSessionName: "Parent",
    parentCwd,
    isProjectTrusted: () => trusted,
    store,
    tmux: tmux.exec,
  });
}

function children(): string[] {
  try {
    return fs.readdirSync(path.join(store.root, "children"));
  } catch {
    return [];
  }
}

describe("delegate", () => {
  it("creates each child's records, launches it, and returns outcomes in task order", async () => {
    const launched: FakeSession[] = [];
    const tmux = createFakeTmux({
      onNewSession: (session) => {
        launched.push(session);
        ready(session);
      },
    });

    const result = runtime(tmux).delegate(
      [task(1), task(2, { cwd: path.join(root, "elsewhere") })],
      {
        label: "review",
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toHaveLength(2);
    const [first, second] = launched.map((session) => ({
      childId: childIdOf(session),
      requestId: "r1",
    }));
    // The second child finishes first; outcomes still follow task order.
    settle(second, { status: "completed", answer: null, humanIntervened: false });
    settle(first, {
      status: "completed",
      answer: { path: "/s.jsonl", entryId: "e1" },
      humanIntervened: true,
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    const executions = await result;
    expect(executions.map((execution) => execution.outcome)).toEqual([
      {
        status: "completed",
        request: first,
        answer: { path: "/s.jsonl", entryId: "e1" },
        humanIntervened: true,
      },
      { status: "completed", request: second, answer: null, humanIntervened: false },
    ]);
    expect(executions.map((execution) => execution.task.taskNumber)).toEqual([1, 2]);

    expect(store.readChild(first.childId)).toMatchObject({
      parent: { sessionId: "parent-session", name: "Parent" },
      worktree: parentCwd,
      cwd: parentCwd,
      agent: {
        name: "scout",
        source: "user",
        model: "mock/echo",
        tools: ["read"],
        timeoutMinutes: 5,
      },
      projectTrust: true,
      label: "review",
      taskNumber: 1,
      depth: 1,
      piCommand: [process.execPath, process.argv[1]],
    });
    expect(store.readChild(second.childId)).toMatchObject({
      worktree: parentCwd,
      cwd: path.join(root, "elsewhere"),
      projectTrust: false,
    });
    expect(
      fs.readFileSync(path.join(store.childDir(first.childId), "system-prompt.md"), "utf8"),
    ).toBe("You scout.");
    expect(store.readRequest(first)).toMatchObject({ instruction: "Task 1" });
    expect(launched[0].command).toContain("--approve");
    expect(launched[1].command).toContain("--no-approve");
  });

  it("resolves a relative task cwd against the parent cwd and keeps a nested cwd trusted", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const result = runtime(tmux).delegate([task(1, { cwd: "pkg", timeoutMs: POLL_MS })], {});
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    const [execution] = await result;
    const request = (execution.outcome as { request: RequestRef }).request;

    expect(store.readChild(request.childId)).toMatchObject({
      cwd: path.join(parentCwd, "pkg"),
      projectTrust: true,
    });
  });

  it("records the Git top level of the parent cwd as the owning worktree", async () => {
    execFileSync("git", ["init", "-q"], { cwd: parentCwd });
    const tmux = createFakeTmux({ onNewSession: ready });
    const nested = createParentRuntime({
      parentSessionId: "parent-session",
      parentCwd: path.join(parentCwd, "pkg"),
      isProjectTrusted: () => true,
      store,
      tmux: tmux.exec,
    });
    const result = nested.delegate([task(1, { cwd: ".", timeoutMs: POLL_MS })], {});
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    const [execution] = await result;
    const request = (execution.outcome as { request: RequestRef }).request;

    expect(store.readChild(request.childId)).toMatchObject({
      worktree: parentCwd,
      cwd: path.join(parentCwd, "pkg"),
    });
  });

  it("gives no child project trust when the parent project is untrusted", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const result = runtime(tmux, false).delegate([task(1, { timeoutMs: POLL_MS })], {});
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    const [execution] = await result;
    const request = (execution.outcome as { request: RequestRef }).request;

    expect(store.readChild(request.childId).projectTrust).toBe(false);
  });

  it("strips control characters other than newlines and tabs from the instruction", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const result = runtime(tmux).delegate(
      [task(1, { instruction: "line one\r\n\tline two\u0007\u001b[31m", timeoutMs: POLL_MS })],
      {},
    );
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    const [execution] = await result;
    const request = (execution.outcome as { request: RequestRef }).request;

    expect(store.readRequest(request)?.instruction).toBe("line one\n\tline two[31m");
  });

  it("creates nothing when aborted before the first child exists", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const controller = new AbortController();
    controller.abort();

    const executions = await runtime(tmux).delegate([task(1), task(2)], {
      signal: controller.signal,
    });

    expect(executions.map((execution) => execution.outcome)).toEqual([
      { status: "aborted", stage: "before_launch" },
      { status: "aborted", stage: "before_launch" },
    ]);
    expect(children()).toEqual([]);
    expect(tmux.launches).toBe(0);
  });

  it("leaves the request on disk and the child running when aborted after submission", async () => {
    const controller = new AbortController();
    const tmux = createFakeTmux({
      onNewSession: (session) => {
        ready(session);
        controller.abort();
      },
    });

    const executions = await runtime(tmux).delegate([task(1), task(2)], {
      signal: controller.signal,
    });

    const [first, second] = executions.map((execution) => execution.outcome);
    expect(second).toEqual({ status: "aborted", stage: "before_launch" });
    expect(first).toMatchObject({ status: "aborted", stage: "observing" });
    const request = (first as { request: RequestRef }).request;
    expect(store.readRequest(request)).toBeDefined();
    expect(tmux.sessions.has(`sa-${request.childId}`)).toBe(true);
    expect(children()).toHaveLength(1);
  });

  it("times out from readiness and leaves the child running", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const result = runtime(tmux).delegate([task(1, { timeoutMs: 2_000 })], {});

    await vi.advanceTimersByTimeAsync(2_000 + POLL_MS);
    const [execution] = await result;

    expect(execution.outcome).toMatchObject({ status: "timed_out" });
    expect(tmux.sessions.size).toBe(1);
  });

  it("reports progress as the request moves through queued, running and blocked", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const lines: string[] = [];
    const result = runtime(tmux).delegate([task(1, { timeoutMs: POLL_MS * 4 })], {
      onProgress: (update) => lines.push(`${update.taskNumber}: ${update.line}`),
    });
    await vi.advanceTimersByTimeAsync(0);
    const [childId] = children();
    store.writeResult({
      version: 1,
      request: { childId, requestId: "r1" },
      nonce: "n",
      phase: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    store.writeStatus(childId, {
      version: 1,
      nonce: "n",
      pid: 1,
      state: "running",
      current: "r1",
      blocked: { label: "Bash permission: waiting", since: "2026-01-01T00:00:00.000Z" },
    });
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    const [execution] = await result;

    expect(lines).toEqual([
      `1: Child ${childId}, request r1: queued`,
      `1: Child ${childId}, request r1: running`,
      `1: Child ${childId}, request r1: blocked`,
    ]);
    expect(execution.outcome).toEqual({
      status: "timed_out",
      request: { childId, requestId: "r1" },
    });
  });

  it("reports session_closed only after the child is gone on two consecutive polls", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const result = runtime(tmux).delegate([task(1)], {});
    await vi.advanceTimersByTimeAsync(0);
    const [childId] = children();

    tmux.kill(childId);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    let outcome: unknown;
    void result.then(([execution]) => {
      outcome = execution.outcome;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(outcome).toEqual({ status: "session_closed", request: { childId, requestId: "r1" } });
  });

  it("returns a result the child settled just before exiting rather than session_closed", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const result = runtime(tmux).delegate([task(1)], {});
    await vi.advanceTimersByTimeAsync(0);
    const [childId] = children();

    settle(
      { childId, requestId: "r1" },
      { status: "failed", reason: "error", error: "boom", humanIntervened: false },
    );
    tmux.kill(childId);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    const [execution] = await result;
    expect(execution.outcome).toEqual({
      status: "failed",
      request: { childId, requestId: "r1" },
      reason: "error",
      error: "boom",
    });
  });

  it("maps launch failure and missing readiness to launch outcomes", async () => {
    const failing = createFakeTmux({ newSessionError: "no server" });
    const [failed] = await runtime(failing).delegate([task(1)], {});
    expect(failed.outcome).toEqual({
      status: "launch_failed",
      childId: expect.stringMatching(/^scout-/),
      error: expect.stringContaining("no server"),
    });

    const silent = createFakeTmux();
    const pending = runtime(silent).delegate([task(1)], {});
    await vi.advanceTimersByTimeAsync(31_000);
    const [indeterminate] = await pending;
    expect(indeterminate.outcome).toMatchObject({
      status: "launch_indeterminate",
      request: { requestId: "r1" },
      error: expect.stringContaining("did not report readiness"),
    });
  });

  it("reports observation_failed when a record becomes invalid during the wait", async () => {
    const tmux = createFakeTmux({ onNewSession: ready });
    const result = runtime(tmux).delegate([task(1)], {});
    await vi.advanceTimersByTimeAsync(0);
    const [childId] = children();
    fs.writeFileSync(path.join(store.childDir(childId), "requests", "r1", "result.json"), "{}");
    await vi.advanceTimersByTimeAsync(POLL_MS);

    const [execution] = await result;
    expect(execution.outcome).toMatchObject({
      status: "observation_failed",
      request: { childId, requestId: "r1" },
      error: expect.stringContaining("result.json"),
    });
  });

  it("throws before creating anything when tmux cannot be run", async () => {
    const missing = createParentRuntime({
      parentSessionId: "parent-session",
      parentCwd,
      isProjectTrusted: () => true,
      store,
      tmux: async () => {
        throw new Error("spawn tmux ENOENT");
      },
    });

    await expect(missing.delegate([task(1)], {})).rejects.toThrow(/tmux/);
    expect(children()).toEqual([]);
  });
});

/** A child of this parent with one request, as an earlier delegation leaves it. */
function existingChild(overrides: { parentSessionId?: string } = {}): RequestRef {
  const child = store.createChild(
    {
      parent: { sessionId: overrides.parentSessionId ?? "parent-session" },
      worktree: parentCwd,
      cwd: parentCwd,
      agent: { name: "scout", source: "user", timeoutMinutes: 5 },
      projectTrust: true,
      depth: 1,
      piCommand: ["node", "pi"],
    },
    "You scout.",
  );
  return store.createRequest(child.childId, "Task 1").request;
}

/** A live session for a child whose bridge is ready under `nonce`. */
function liveChild(tmux: ReturnType<typeof createFakeTmux>, childId: string, nonce = "n"): void {
  tmux.sessions.set(`sa-${childId}`, {
    name: `sa-${childId}`,
    cwd: parentCwd,
    env: { PI_SUBAGENT_NONCE: nonce },
    command: [],
  });
  store.writeStatus(childId, { version: 1, nonce, pid: 1, state: "idle" });
}

describe("retrieveResult", () => {
  it("returns a settled result immediately without launching", async () => {
    const tmux = createFakeTmux();
    const request = existingChild();
    settle(request, { status: "completed", answer: null, humanIntervened: false });

    const outcome = await runtime(tmux).retrieveResult(request, { timeoutMs: 60_000 });

    expect(outcome).toEqual({
      status: "settled",
      request,
      result: { status: "completed", answer: null, humanIntervened: false },
    });
    expect(tmux.launches).toBe(0);
  });

  it("gives each call a fresh timeout and leaves the request and child alone", async () => {
    const tmux = createFakeTmux();
    const request = existingChild();
    liveChild(tmux, request.childId);
    store.writeResult({
      version: 1,
      request,
      nonce: "n",
      phase: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const before = fs.readFileSync(
      path.join(store.childDir(request.childId), "requests", "r1", "request.json"),
      "utf8",
    );
    const parent = runtime(tmux);

    for (let call = 0; call < 2; call++) {
      const pending = parent.retrieveResult(request, { timeoutMs: POLL_MS * 4 });
      let done = false;
      void pending.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(await pending).toEqual({
        status: "pending",
        request,
        state: "running",
        stopped: "timed_out",
      });
    }

    expect(
      fs.readFileSync(
        path.join(store.childDir(request.childId), "requests", "r1", "request.json"),
        "utf8",
      ),
    ).toBe(before);
    expect(store.listRequestIds(request.childId)).toEqual(["r1"]);
    expect(tmux.sessions.has(`sa-${request.childId}`)).toBe(true);
    expect(tmux.calls.map((args) => args[0])).not.toContain("kill-session");
    expect(tmux.launches).toBe(0);
  });

  it("stops waiting on abort without touching the request", async () => {
    const tmux = createFakeTmux();
    const request = existingChild();
    liveChild(tmux, request.childId);
    const controller = new AbortController();

    const pending = runtime(tmux).retrieveResult(request, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toEqual({
      status: "pending",
      request,
      state: "queued",
      stopped: "aborted",
    });
    expect(store.readResult(request)).toBeUndefined();
    expect(tmux.sessions.has(`sa-${request.childId}`)).toBe(true);
  });

  it.each([
    { started: false, label: "never started" },
    { started: true, label: "running" },
  ])(
    "reports lost with started $started for a stopped child after two polls ($label)",
    async ({ started }) => {
      const tmux = createFakeTmux();
      const request = existingChild();
      if (started) {
        store.writeResult({
          version: 1,
          request,
          nonce: "old",
          phase: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
        });
      }

      let outcome: unknown;
      void runtime(tmux)
        .retrieveResult(request, { timeoutMs: 60_000 })
        .then((value) => {
          outcome = value;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(POLL_MS);

      expect(outcome).toEqual({ status: "lost", request, started });
      expect(tmux.launches).toBe(0);
    },
  );

  it("rejects another parent's child and an unknown request", async () => {
    const tmux = createFakeTmux();
    const foreign = existingChild({ parentSessionId: "other-session" });
    settle(foreign, { status: "completed", answer: null, humanIntervened: false });
    const own = existingChild();

    await expect(runtime(tmux).retrieveResult(foreign, { timeoutMs: 1 })).rejects.toThrow(
      /another parent/,
    );
    await expect(
      runtime(tmux).retrieveResult({ ...own, requestId: "r9" }, { timeoutMs: 1 }),
    ).rejects.toThrow(/no request r9/);
  });
});

/** The Pi session file a child writes once its conversation starts. */
function writeSessionFile(childId: string): void {
  fs.writeFileSync(
    path.join(store.childDir(childId), "session", `2026-01-01T00-00-00-000Z_${childId}.jsonl`),
    "{}\n",
  );
}

const done: RequestResult = { status: "completed", answer: null, humanIntervened: false };

describe("ask", () => {
  it("submits the next request to a live child and waits for its result", async () => {
    const tmux = createFakeTmux();
    const first = existingChild();
    settle(first, done);
    writeSessionFile(first.childId);
    liveChild(tmux, first.childId);
    const next = { childId: first.childId, requestId: "r2" };

    const asked = runtime(tmux).ask(first.childId, "Follow up\u0007", { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.readRequest(next)?.instruction).toBe("Follow up");
    settle(next, done);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(await asked).toEqual({
      status: "submitted",
      request: next,
      retrieval: { status: "settled", request: next, result: done },
    });
    expect(tmux.launches).toBe(0);
  });

  it("is busy at one running and one queued request, and a cancelled wait leaves the queue", async () => {
    const tmux = createFakeTmux();
    const first = existingChild();
    writeSessionFile(first.childId);
    liveChild(tmux, first.childId);
    store.writeResult({
      version: 1,
      request: first,
      nonce: "n",
      phase: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const parent = runtime(tmux);
    const controller = new AbortController();

    const queued = parent.ask(first.childId, "Second", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await queued).toMatchObject({
      status: "submitted",
      request: { requestId: "r2" },
      retrieval: { status: "pending", state: "queued", stopped: "aborted" },
    });

    expect(await parent.ask(first.childId, "Third", { timeoutMs: 60_000 })).toEqual({
      status: "rejected",
      childId: first.childId,
      reason: "busy",
      error: `Child ${first.childId} already has a request running and one queued. Nothing was submitted.`,
    });
    expect(store.listRequestIds(first.childId)).toEqual(["r1", "r2"]);
    expect(store.readResult({ childId: first.childId, requestId: "r2" })).toBeUndefined();
  });

  it("resumes a stopped child, whose bridge interrupts the stale request, then admits the ask", async () => {
    const first = existingChild();
    writeSessionFile(first.childId);
    store.writeResult({
      version: 1,
      request: first,
      nonce: "old",
      phase: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    store.createRequest(first.childId, "Queued before the stop");
    const tmux = createFakeTmux({
      onNewSession: (session) => {
        // The bridge's startup reconciliation, then readiness.
        settle(first, {
          status: "failed",
          reason: "interrupted",
          error: "stopped",
          humanIntervened: false,
        });
        ready(session);
      },
    });

    const asked = runtime(tmux).ask(first.childId, "Third", { timeoutMs: POLL_MS });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(await asked).toMatchObject({
      status: "submitted",
      request: { childId: first.childId, requestId: "r3" },
      retrieval: { status: "pending", state: "queued", stopped: "timed_out" },
    });
    expect(tmux.launches).toBe(1);
  });

  it("reports resume_failed and submits nothing when the child cannot be resumed", async () => {
    const tmux = createFakeTmux({ newSessionError: "no server" });
    const first = existingChild();

    const outcome = await runtime(tmux).ask(first.childId, "Again", { timeoutMs: 60_000 });

    expect(outcome).toMatchObject({
      status: "rejected",
      childId: first.childId,
      reason: "resume_failed",
      error: expect.stringContaining("no server"),
    });
    expect(store.listRequestIds(first.childId)).toEqual(["r1"]);
  });

  it("submits nothing when aborted before submission", async () => {
    const tmux = createFakeTmux();
    const first = existingChild();
    liveChild(tmux, first.childId);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runtime(tmux).ask(first.childId, "Again", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({ status: "rejected", reason: "aborted" });
    expect(store.listRequestIds(first.childId)).toEqual(["r1"]);
  });

  it("rejects another parent's child as invalid_target without touching it", async () => {
    const tmux = createFakeTmux();
    const foreign = existingChild({ parentSessionId: "other-session" });
    liveChild(tmux, foreign.childId);

    const outcome = await runtime(tmux).ask(foreign.childId, "Mine now", { timeoutMs: 60_000 });

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "invalid_target",
      error: expect.stringContaining("another parent"),
    });
    expect(store.listRequestIds(foreign.childId)).toEqual(["r1"]);
    expect(tmux.launches).toBe(0);
  });

  it("rejects a missing cwd, a missing session file, and lost project trust as invalid_target", async () => {
    const tmux = createFakeTmux();
    const goneCwd = existingChild();
    const childJson = path.join(store.childDir(goneCwd.childId), "child.json");
    fs.writeFileSync(
      childJson,
      JSON.stringify({ ...store.readChild(goneCwd.childId), cwd: path.join(root, "gone") }),
    );
    const noSession = existingChild();
    settle(noSession, done);
    const trusted = existingChild();

    const parent = runtime(tmux, false);
    const outcomes = [
      await parent.ask(goneCwd.childId, "Again", { timeoutMs: 1 }),
      await parent.ask(noSession.childId, "Again", { timeoutMs: 1 }),
      await parent.ask(trusted.childId, "Again", { timeoutMs: 1 }),
    ];

    expect(outcomes).toEqual([
      expect.objectContaining({ reason: "invalid_target", error: expect.stringContaining("cwd") }),
      expect.objectContaining({
        reason: "invalid_target",
        error: expect.stringContaining("session file is missing"),
      }),
      expect.objectContaining({
        reason: "invalid_target",
        error: expect.stringContaining("/trust"),
      }),
    ]);
    expect(tmux.launches).toBe(0);
  });
});
