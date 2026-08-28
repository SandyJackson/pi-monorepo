import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptedHerdr, type RpcResponse, waitForRpcCount } from "../herdr-test-support.ts";
import {
  type DelegatedTaskRecord,
  executeHerdrDelegation,
  MAX_DELEGATED_TASKS,
} from "./delegation.ts";

type HerdrAgentStatus = "idle" | "done" | "working" | "blocked" | "unknown";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function taskRecord(taskNumber: number, task: string, agentName = "alpha"): DelegatedTaskRecord {
  return {
    taskNumber,
    agent: agentName,
    instruction: task,
    cwd: "/tmp/project",
    config: { name: agentName, systemPromptBody: "" },
  };
}

interface DelegatedHerdrOptions {
  /**
   * Per-pane observation status queues consumed per agent.get poll.
   * A pane without a queue (or with an exhausted queue) reports "working".
   */
  statuses?: Map<string, HerdrAgentStatus[]>;
  /** pane.split result pane ids in call order. */
  splitPaneIds?: string[];
  /** 1-based pane.split calls that fail instead of creating a pane. */
  failingSplitCalls?: number[];
  /** The discovered tab's pane, when the tab is not created here. */
  existingPane?: { paneId: string; tabId: string };
  agentStart?: (request: { paneId: string }) => RpcResponse;
  tabList?: RpcResponse;
}

/**
 * Scripted Herdr with a shared subagents tab and per-pane status queues.
 * agent.start echoes the target pane back as the new child pane id.
 */
function createDelegatedHerdr(options: DelegatedHerdrOptions = {}) {
  const {
    statuses = new Map(),
    splitPaneIds = [],
    failingSplitCalls,
    existingPane,
    agentStart,
    tabList,
  } = options;
  const existing = existingPane ?? { paneId: "existing-pane", tabId: "subagent-tab" };
  let splitCall = 0;
  let splitIdCall = 0;
  return createScriptedHerdr((request) => {
    if (request.method === "tab.list")
      return tabList ?? { result: { tabs: [{ tab_id: "subagent-tab", label: "subagents" }] } };
    if (request.method === "pane.list")
      return { result: { panes: [{ pane_id: existing.paneId, tab_id: existing.tabId }] } };
    if (request.method === "tab.create") {
      return {
        result: {
          type: "tab_created",
          tab: { tab_id: "new-tab" },
          root_pane: { pane_id: "root-pane" },
        },
      };
    }
    if (request.method === "pane.split") {
      splitCall += 1;
      if (failingSplitCalls?.includes(splitCall)) {
        return { error: { code: "split_failed", message: "cannot split" } };
      }
      // Failed splits consume no pane id.
      splitIdCall += 1;
      const paneId = splitPaneIds[splitIdCall - 1] ?? `split-${splitIdCall}`;
      return { result: { type: "pane_info", pane: { pane_id: paneId } } };
    }
    if (request.method === "agent.list") return { result: { agents: [] } };
    if (request.method === "agent.start") {
      const paneId =
        typeof request.params.pane_id === "string" ? request.params.pane_id : "unknown-pane";
      return agentStart ? agentStart({ paneId }) : { result: { pane_id: paneId } };
    }
    if (request.method === "agent.get") {
      const target = typeof request.params.target === "string" ? request.params.target : "";
      const status = statuses.get(target)?.shift() ?? "working";
      return { result: { agent: { agent_status: status } } };
    }
    return { result: {} };
  });
}

/** Wrap a herdr's rpc to record a picked value from each matching call. */
function recordRpc<T>(
  herdr: ReturnType<typeof createScriptedHerdr>,
  method: string,
  pick: (params: Record<string, unknown>) => T,
  wrapped?: typeof herdr.rpcCall,
): { rpc: typeof herdr.rpcCall; records: T[] } {
  const records: T[] = [];
  const next = wrapped ?? herdr.rpcCall;
  const rpc: typeof next = (m, params, timeoutMs, signal) => {
    if (m === method) records.push(pick(params as Record<string, unknown>));
    return next(m, params, timeoutMs, signal);
  };
  return { rpc, records };
}

function delegate(
  herdr: ReturnType<typeof createScriptedHerdr>,
  tasks: DelegatedTaskRecord[],
  options: {
    rpc?: typeof herdr.rpcCall;
    workspaceId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (update: { taskNumber: number; line: string }) => void;
  } = {},
) {
  return executeHerdrDelegation(tasks, {
    rpc: options.rpc ?? herdr.rpcCall,
    workspaceId: options.workspaceId ?? "delegation-workspace",
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onProgress: options.onProgress,
  });
}

describe("herdr/delegation — ordered outcome contract", () => {
  it("returns one outcome per record in input order when turns settle out of order", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["pane-1", ["working", "working", "working", "idle", "idle"]],
      ["pane-2", ["working", "idle", "idle"]],
      ["pane-3", ["working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({ statuses, splitPaneIds: ["pane-1", "pane-2", "pane-3"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const task1 = taskRecord(1, "First");
    const task2 = taskRecord(2, "Second", "beta");
    const task3 = taskRecord(3, "Third");
    const delegation = delegate(herdr, [task1, task2, task3]);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.map((result) => result.task.taskNumber)).toEqual([1, 2, 3]);
    expect(results.map((result) => result.outcome.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    // The same records are carried through untouched.
    expect(results[0].task).toBe(task1);
    expect(results[1].task).toBe(task2);
    expect(results[2].task).toBe(task3);
  });

  it("returns an empty result for an empty delegation without contacting Herdr", async () => {
    const herdr = createDelegatedHerdr();
    const results = await delegate(herdr, []);
    expect(results).toEqual([]);
    expect(herdr.calledMethods).toEqual([]);
  });

  it("forwards progress updates with the task number", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([["pane-1", ["working", "idle", "idle"]]]);
    const herdr = createDelegatedHerdr({ statuses, splitPaneIds: ["pane-1"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const progress: Array<{ taskNumber: number; line: string }> = [];
    const delegation = delegate(herdr, [taskRecord(1, "Only")], {
      onProgress: (update) => progress.push(update),
    });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

    await delegation;
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((update) => update.taskNumber === 1)).toBe(true);
    expect(progress.some((update) => update.line.includes("watching:working"))).toBe(true);
  });
});

describe("herdr/delegation — workspace and launch invariants", () => {
  it("launches task 5 while task 1 is still being observed", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["pane-2", ["working", "idle", "idle"]],
      ["pane-3", ["working", "idle", "idle"]],
      ["pane-4", ["working", "idle", "idle"]],
      ["pane-5", ["working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({
      statuses,
      splitPaneIds: ["pane-1", "pane-2", "pane-3", "pane-4", "pane-5"],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const tasks = [1, 2, 3, 4, 5].map((n) => taskRecord(n, `Task ${n}`, n % 2 ? "alpha" : "beta"));
    const delegation = delegate(herdr, tasks);
    let settled = false;
    void delegation.then(() => {
      settled = true;
    });

    // Inter-launch pauses total 4 x 250ms; afterwards every task has launched
    // while task 1 is still being observed.
    await vi.advanceTimersByTimeAsync(1100);
    expect(settled).toBe(false);
    expect(herdr.calledMethods.filter((method) => method === "agent.start")).toHaveLength(5);

    // Release task 1's turn and confirm the ordered contract still holds.
    statuses.set("pane-1", ["idle", "idle"]);
    await vi.advanceTimersByTimeAsync(3200);
    const results = await delegation;
    expect(results.map((result) => result.outcome.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(herdr.calledMethods).not.toContain("pane.close");
  });

  it("places the first child in a new tab's root pane, then splits right and down", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["root-pane", ["working", "idle", "idle"]],
      ["pane-2", ["working", "idle", "idle"]],
      ["pane-3", ["working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({
      statuses,
      tabList: { result: { tabs: [] } },
      splitPaneIds: ["pane-2", "pane-3"],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const { rpc, records: splitDirections } = recordRpc(herdr, "pane.split", (p) => ({
      target: p.target_pane_id,
      direction: p.direction,
    }));

    const tasks = [1, 2, 3].map((n) => taskRecord(n, `Task ${n}`, n % 2 ? "alpha" : "beta"));
    const delegation = delegate(herdr, tasks, { rpc });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.every((result) => result.outcome.status === "completed")).toBe(true);
    // A new tab's first child takes the root pane; every later child splits,
    // and the first split of a tab that already holds a child goes down.
    expect(splitDirections).toEqual([
      { target: "root-pane", direction: "down" },
      { target: "pane-2", direction: "down" },
    ]);
  });

  it("reuses the target pane after a confirmed launch failure and continues with siblings", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["pane-1", ["working", "idle", "idle"]],
      ["pane-3", ["working", "idle", "idle"]],
    ]);
    let startCalls = 0;
    const herdr = createDelegatedHerdr({
      statuses,
      splitPaneIds: ["pane-1", "pane-3"],
      agentStart: ({ paneId }) => {
        startCalls += 1;
        // Only task 1's launch is rejected; task 2 reuses the same pane.
        if (startCalls === 1)
          return { error: { code: "launch_rejected", message: "launch denied" } };
        return { result: { pane_id: paneId } };
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { rpc, records: startPaneIds } = recordRpc(
      herdr,
      "agent.start",
      (p) => p.pane_id as string,
    );

    const tasks = [1, 2, 3].map((n) => taskRecord(n, `Task ${n}`, n % 2 ? "alpha" : "beta"));
    const delegation = delegate(herdr, tasks, { rpc });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.map((result) => result.outcome.status)).toEqual([
      "launch_failed",
      "completed",
      "completed",
    ]);
    expect(results[0].outcome).toMatchObject({ status: "launch_failed", error: "launch denied" });
    // Task 2 reused task 1's pane; task 3 got a fresh split.
    expect(startPaneIds).toEqual(["pane-1", "pane-1", "pane-3"]);
  });

  it("never reuses a pane after an indeterminate launch", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([["pane-2", ["working", "idle", "idle"]]]);
    const herdr = createDelegatedHerdr({
      statuses,
      splitPaneIds: ["pane-1", "pane-2"],
      agentStart: ({ paneId }) =>
        paneId === "pane-1" ? { result: {} } : { result: { pane_id: paneId } },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { rpc, records: startPaneIds } = recordRpc(
      herdr,
      "agent.start",
      (p) => p.pane_id as string,
    );

    const tasks = [taskRecord(1, "First"), taskRecord(2, "Second", "beta")];
    const delegation = delegate(herdr, tasks, { rpc });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.map((result) => result.outcome.status)).toEqual([
      "launch_indeterminate",
      "completed",
    ]);
    expect(startPaneIds).toEqual(["pane-1", "pane-2"]);
  });

  it("matches plain and numbered subagents tab labels", async () => {
    // Herdr 0.7 displays numbered tab labels as, for example, "[4] subagents";
    // such a tab must be reused instead of creating a duplicate.
    const herdr = createDelegatedHerdr({
      statuses: new Map<string, HerdrAgentStatus[]>([["pane-1", ["working", "idle", "idle"]]]),
      tabList: { result: { tabs: [{ tab_id: "numbered-tab", label: "[4] subagents" }] } },
      existingPane: { paneId: "numbered-pane", tabId: "numbered-tab" },
      splitPaneIds: ["pane-1"],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const delegation = delegate(herdr, [taskRecord(1, "Only")]);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results[0].outcome.status).toBe("completed");
    // The numbered tab was reused: no tab.create occurred and the first child
    // split from the existing tab's pane.
    expect(herdr.calledMethods).not.toContain("tab.create");
    expect(herdr.calledMethods).toContain("pane.split");
  });

  it("continues with siblings after a pane.split failure", async () => {
    const herdr = createDelegatedHerdr({
      statuses: new Map<string, HerdrAgentStatus[]>([
        ["pane-2", ["working", "idle", "idle"]],
        ["pane-3", ["working", "idle", "idle"]],
      ]),
      // The first split (task 1) fails; later siblings still launch.
      splitPaneIds: ["pane-2", "pane-3"],
      failingSplitCalls: [1],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const tasks = [taskRecord(1, "First"), taskRecord(2, "Second", "beta"), taskRecord(3, "Third")];
    const delegation = delegate(herdr, tasks);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.map((result) => result.outcome.status)).toEqual([
      "launch_failed",
      "completed",
      "completed",
    ]);
    expect(results[0].outcome).toMatchObject({ status: "launch_failed", error: "cannot split" });
  });

  it("never reuses a pane whose cwd differs from the next task", async () => {
    const herdr = createDelegatedHerdr({
      statuses: new Map<string, HerdrAgentStatus[]>([["pane-2", ["working", "idle", "idle"]]]),
      splitPaneIds: ["pane-1", "pane-2"],
      agentStart: ({ paneId }) =>
        paneId === "pane-1"
          ? { error: { code: "launch_rejected", message: "launch denied" } }
          : { result: { pane_id: paneId } },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const starts = recordRpc(herdr, "agent.start", (p) => p.pane_id as string);
    const splits = recordRpc(herdr, "pane.split", (p) => p.cwd as string | undefined, starts.rpc);

    // Task 1 fails; task 2 has a different cwd, so it must split its own pane
    // instead of reusing task 1's (which carries task 1's directory).
    const task2 = { ...taskRecord(2, "Second", "beta"), cwd: "/tmp/other-project" };
    const tasks = [taskRecord(1, "First"), task2];
    const delegation = delegate(herdr, tasks, { rpc: splits.rpc });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.map((result) => result.outcome.status)).toEqual(["launch_failed", "completed"]);
    expect(starts.records).toEqual(["pane-1", "pane-2"]);
    expect(splits.records).toEqual(["/tmp/project", "/tmp/other-project"]);
  });

  it("throws when shared workspace provisioning fails, before any launch", async () => {
    const herdr = createDelegatedHerdr({
      tabList: { error: { code: "internal_error", message: "workspace unreachable" } },
    });

    await expect(delegate(herdr, [taskRecord(1, "First")])).rejects.toThrow(
      "workspace unreachable",
    );
    expect(herdr.calledMethods).toEqual(["tab.list"]);
    expect(herdr.calledMethods).not.toContain("agent.start");
  });

  it("rejects more than eight valid tasks before contacting Herdr", async () => {
    const herdr = createDelegatedHerdr();
    const tasks = Array.from({ length: MAX_DELEGATED_TASKS + 1 }, (_, i) =>
      taskRecord(i + 1, `Task ${i + 1}`),
    );

    await expect(delegate(herdr, tasks)).rejects.toThrow("Max is 8");
    expect(herdr.calledMethods).toEqual([]);
  });

  it("serializes delegations to the same workspace behind the process-wide lock", async () => {
    const releaseTaskStart = Promise.withResolvers<void>();
    const herdrA = createDelegatedHerdr({
      statuses: new Map([["pane-a1", ["working", "idle", "idle"]]]),
      splitPaneIds: ["pane-a1"],
      agentStart: () => ({
        result: releaseTaskStart.promise.then(() => ({ pane_id: "pane-a1" })),
      }),
    });
    const herdrB = createDelegatedHerdr({
      statuses: new Map([["pane-b1", ["working", "idle", "idle"]]]),
      splitPaneIds: ["pane-b1"],
    });

    const delegationA = delegate(herdrA, [taskRecord(1, "Task A")], {
      workspaceId: "shared-workspace",
    });
    await waitForRpcCount(herdrA, 5);
    const delegationB = delegate(herdrB, [taskRecord(1, "Task B", "beta")], {
      workspaceId: "shared-workspace",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // B is blocked by A's in-flight launch; it must not provision its tab yet.
    expect(herdrB.calledMethods).toEqual([]);

    releaseTaskStart.resolve();
    await delegationA;
    const resultsB = await delegationB;
    expect(resultsB[0].outcome.status).toBe("completed");
    expect(herdrB.calledMethods).toContain("tab.list");
  }, 10_000);
});

describe("herdr/delegation — cancellation and timeout", () => {
  it("aborts every task before launch when the signal is already aborted", async () => {
    const herdr = createDelegatedHerdr();
    const results = await delegate(
      herdr,
      [taskRecord(1, "First"), taskRecord(2, "Second", "beta")],
      {
        signal: AbortSignal.abort(),
      },
    );

    expect(results.map((result) => result.outcome)).toEqual([
      { status: "aborted", stage: "before_launch" },
      { status: "aborted", stage: "before_launch" },
    ]);
    expect(herdr.calledMethods).toEqual([]);
  });

  it("stops launching after cancellation while a confirmed session is observing", async () => {
    const herdr = createDelegatedHerdr({ splitPaneIds: ["pane-1"] });
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const tasks = [taskRecord(1, "First"), taskRecord(2, "Second", "beta"), taskRecord(3, "Third")];
    const delegation = delegate(herdr, tasks, { signal: controller.signal });

    // Task 1 is confirmed and its first observation poll has run.
    await waitForRpcCount(herdr, 6);
    controller.abort();
    const results = await delegation;

    expect(results[0].outcome).toMatchObject({
      status: "aborted",
      stage: "observing",
      session: { paneId: "pane-1" },
    });
    expect(results[1].outcome).toEqual({ status: "aborted", stage: "before_launch" });
    expect(results[2].outcome).toEqual({ status: "aborted", stage: "before_launch" });
    expect(herdr.calledMethods).not.toContain("pane.close");
    expect(herdr.calledMethods).not.toContain("agent.stop");
  });

  it("reports launch_indeterminate when cancellation hits an in-flight ambiguous start", async () => {
    const herdr = createScriptedHerdr((request) => {
      if (request.method === "tab.list")
        return { result: { tabs: [{ tab_id: "subagent-tab", label: "subagents" }] } };
      if (request.method === "pane.list")
        return { result: { panes: [{ pane_id: "existing-pane", tab_id: "subagent-tab" }] } };
      if (request.method === "pane.split")
        return { result: { type: "pane_info", pane: { pane_id: "pane-1" } } };
      if (request.method === "agent.list") return { result: { agents: [] } };
      if (request.method === "agent.start") return { leavePending: true };
      return { result: {} };
    });
    const controller = new AbortController();

    const tasks = [taskRecord(1, "First"), taskRecord(2, "Second", "beta")];
    const delegation = delegate(herdr, tasks, { signal: controller.signal });
    await waitForRpcCount(herdr, 5);
    controller.abort();
    const results = await delegation;

    expect(results[0].outcome).toMatchObject({
      status: "launch_indeterminate",
      possiblePaneId: "pane-1",
    });
    expect(results[1].outcome).toEqual({ status: "aborted", stage: "before_launch" });
  });

  it("starts the timeout at confirmed launch, not when the launch request began", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([["pane-1", ["working", "idle", "idle"]]]);
    let startAttempts = 0;
    const herdr = createDelegatedHerdr({
      statuses,
      splitPaneIds: ["pane-1"],
      agentStart: () => {
        startAttempts += 1;
        // Two pane-busy retries delay the confirmed launch to ~500ms.
        if (startAttempts <= 2) return { error: { code: "agent_pane_busy", message: "pane busy" } };
        return { result: { pane_id: "pane-1" } };
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const delegation = delegate(herdr, [taskRecord(1, "Only")], { timeoutMs: 1000 });
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    // The launch was confirmed at ~500ms, so the turn had until ~1500ms; the
    // working + two settled polls (~2100ms) complete instead of timing out.
    expect(results[0].outcome.status).toBe("completed");
    expect(startAttempts).toBe(3);
  });
});
