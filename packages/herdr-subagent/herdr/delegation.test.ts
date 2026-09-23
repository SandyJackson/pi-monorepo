import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScriptedHerdr,
  type RpcRequest,
  type RpcResponse,
  waitForRpcCount,
} from "../herdr-test-support.ts";
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
  /**
   * Responses for the discovery calls this implementation must never make.
   * A delegation that consults them would reuse an old tab instead of
   * creating its own.
   */
  existingTabs?: { tabList: RpcResponse; paneList: RpcResponse };
  agentStart?: (request: { paneId: string }) => RpcResponse;
  tabCreate?: (request: RpcRequest) => RpcResponse;
}

/**
 * Scripted Herdr that creates one new tab per delegation and reports
 * per-pane status queues. agent.start echoes the target pane back as the
 * new child pane id.
 */
function createDelegatedHerdr(options: DelegatedHerdrOptions = {}) {
  const {
    statuses = new Map(),
    splitPaneIds = [],
    failingSplitCalls,
    existingTabs,
    agentStart,
    tabCreate,
  } = options;
  let splitCall = 0;
  let splitIdCall = 0;
  return createScriptedHerdr((request) => {
    if (request.method === "tab.create") {
      return (
        tabCreate?.(request) ?? {
          result: {
            type: "tab_created",
            tab: { tab_id: "new-tab" },
            root_pane: { pane_id: "root-pane" },
          },
        }
      );
    }
    // Discovery calls must never be made; when scripted at all, they exist
    // only to prove a delegation ignores pre-existing subagents tabs.
    if (request.method === "tab.list") {
      return (
        existingTabs?.tabList ?? {
          error: { code: "internal_error", message: "unexpected tab.list" },
        }
      );
    }
    if (request.method === "pane.list") {
      return (
        existingTabs?.paneList ?? {
          error: { code: "internal_error", message: "unexpected pane.list" },
        }
      );
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
    label?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (update: { taskNumber: number; line: string }) => void;
  } = {},
) {
  return executeHerdrDelegation(tasks, {
    rpc: options.rpc ?? herdr.rpcCall,
    workspaceId: options.workspaceId ?? "delegation-workspace",
    label: options.label,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onProgress: options.onProgress,
  });
}

describe("herdr/delegation — ordered outcome contract", () => {
  it("returns one outcome per record in input order when turns settle out of order", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["root-pane", ["working", "working", "working", "idle", "idle"]],
      ["pane-2", ["working", "idle", "idle"]],
      ["pane-3", ["working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({ statuses, splitPaneIds: ["pane-2", "pane-3"] });
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
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["root-pane", ["working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({ statuses });
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

describe("herdr/delegation — per-delegation tab placement", () => {
  it("creates a new unfocused tab for each delegation without consulting existing tabs", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      // Two delegations each run one child in the tab's root pane.
      ["root-pane", ["working", "idle", "idle", "working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({
      statuses,
      // Herdr reports a pre-existing shared subagents tab; it must be ignored.
      existingTabs: {
        tabList: { result: { tabs: [{ tab_id: "old-tab", label: "subagents" }] } },
        paneList: { result: { panes: [{ pane_id: "old-pane", tab_id: "old-tab" }] } },
      },
    });
    const creates = recordRpc(herdr, "tab.create", (p) => ({
      workspaceId: p.workspace_id,
      cwd: p.cwd,
      label: p.label,
      focus: p.focus,
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const first = delegate(herdr, [taskRecord(1, "First")], { rpc: creates.rpc });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);
    expect((await first).map((result) => result.outcome.status)).toEqual(["completed"]);

    const second = delegate(herdr, [taskRecord(1, "Second", "beta")], { rpc: creates.rpc });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);
    expect((await second).map((result) => result.outcome.status)).toEqual(["completed"]);
    expect(creates.records).toEqual([
      {
        workspaceId: "delegation-workspace",
        cwd: "/tmp/project",
        label: "sub-agents",
        focus: false,
      },
      {
        workspaceId: "delegation-workspace",
        cwd: "/tmp/project",
        label: "sub-agents",
        focus: false,
      },
    ]);
    expect(herdr.calledMethods).not.toContain("tab.list");
    expect(herdr.calledMethods).not.toContain("pane.list");
  });

  it("forwards a custom tab label all the way to tab.create", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["root-pane", ["working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({ statuses });
    const creates = recordRpc(herdr, "tab.create", (p) => p.label as string);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const delegation = delegate(herdr, [taskRecord(1, "Only")], {
      rpc: creates.rpc,
      label: "review-issue-13",
    });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);
    await delegation;

    expect(creates.records).toEqual(["review-issue-13"]);
  });

  it("falls back to sub-agents for an omitted or blank label", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      // Both delegations place their three children in the same pane ids.
      ["root-pane", ["working", "idle", "idle", "working", "idle", "idle"]],
      ["pane-2", ["working", "idle", "idle", "working", "idle", "idle"]],
      ["pane-3", ["working", "idle", "idle", "working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({
      statuses,
      splitPaneIds: ["pane-2", "pane-3", "pane-2", "pane-3"],
    });
    const creates = recordRpc(herdr, "tab.create", (p) => p.label as string);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const tasks = [
      taskRecord(1, "First", "alpha"),
      taskRecord(2, "Second", "beta"),
      taskRecord(3, "Third", "alpha"),
    ];
    const withoutLabel = delegate(herdr, tasks, { rpc: creates.rpc });
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(800);
    await withoutLabel;

    const blankLabel = delegate(herdr, tasks, { rpc: creates.rpc, label: "   " });
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(800);
    await blankLabel;

    // The fallback ignores agent names entirely; it never invents a lookup
    // or a uniqueness suffix.
    expect(creates.records).toEqual(["sub-agents", "sub-agents"]);
  });

  it("accepts duplicate tab labels across delegations", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      // Two delegations each run one child in the tab's root pane.
      ["root-pane", ["working", "idle", "idle", "working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({ statuses });
    const creates = recordRpc(herdr, "tab.create", (p) => p.label as string);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const first = delegate(herdr, [taskRecord(1, "First")], { rpc: creates.rpc, label: "review" });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);
    expect((await first).map((result) => result.outcome.status)).toEqual(["completed"]);

    const second = delegate(herdr, [taskRecord(1, "Second", "beta")], {
      rpc: creates.rpc,
      label: "review",
    });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);
    expect((await second).map((result) => result.outcome.status)).toEqual(["completed"]);

    expect(creates.records).toEqual(["review", "review"]);
  });

  it("places the first child in the new tab's root pane, then splits down for later siblings", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["root-pane", ["working", "idle", "idle"]],
      ["pane-2", ["working", "idle", "idle"]],
      ["pane-3", ["working", "idle", "idle"]],
    ]);
    const herdr = createDelegatedHerdr({ statuses, splitPaneIds: ["pane-2", "pane-3"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const { rpc, records: splitDirections } = recordRpc(herdr, "pane.split", (p) => ({
      target: p.target_pane_id,
      direction: p.direction,
      focus: p.focus,
    }));

    const tasks = [1, 2, 3].map((n) => taskRecord(n, `Task ${n}`, n % 2 ? "alpha" : "beta"));
    const delegation = delegate(herdr, tasks, { rpc });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.every((result) => result.outcome.status === "completed")).toBe(true);
    // The first child takes the tab's root pane; every later child splits
    // from the most recent pane.
    expect(splitDirections).toEqual([
      { target: "root-pane", direction: "down", focus: false },
      { target: "pane-2", direction: "down", focus: false },
    ]);
  });

  it("creates the delegation tab inside the workspace lock before launching any child", async () => {
    const herdr = createDelegatedHerdr({
      statuses: new Map<string, HerdrAgentStatus[]>([["root-pane", ["working", "idle", "idle"]]]),
    });
    const creates = recordRpc(herdr, "tab.create", (p) => p.label as string);

    await delegate(herdr, [taskRecord(1, "Only")], { rpc: creates.rpc });

    expect(herdr.calledMethods.slice(0, 4)).toEqual([
      "tab.create",
      "agent.list",
      "agent.start",
      "agent.get",
    ]);
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
      splitPaneIds: ["pane-2", "pane-3", "pane-4", "pane-5"],
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
    statuses.set("root-pane", ["idle", "idle"]);
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

  it("reuses the target pane after a confirmed launch failure and continues with siblings", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["root-pane", ["working", "idle", "idle"]],
      ["pane-3", ["working", "idle", "idle"]],
    ]);
    let startCalls = 0;
    const herdr = createDelegatedHerdr({
      statuses,
      splitPaneIds: ["pane-3"],
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
    // Task 2 reused task 1's root pane; task 3 got a fresh split.
    expect(startPaneIds).toEqual(["root-pane", "root-pane", "pane-3"]);
  });

  it("never reuses a pane after an indeterminate launch", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([["pane-2", ["working", "idle", "idle"]]]);
    const herdr = createDelegatedHerdr({
      statuses,
      splitPaneIds: ["pane-2"],
      agentStart: ({ paneId }) =>
        paneId === "root-pane" ? { result: {} } : { result: { pane_id: paneId } },
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
    expect(startPaneIds).toEqual(["root-pane", "pane-2"]);
  });

  it("continues with siblings after a pane.split failure", async () => {
    const herdr = createDelegatedHerdr({
      statuses: new Map<string, HerdrAgentStatus[]>([
        ["root-pane", ["working", "idle", "idle"]],
        ["pane-3", ["working", "idle", "idle"]],
      ]),
      // The first split (task 2) fails; the later sibling still launches.
      splitPaneIds: ["pane-3"],
      failingSplitCalls: [1],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const tasks = [taskRecord(1, "First"), taskRecord(2, "Second", "beta"), taskRecord(3, "Third")];
    const delegation = delegate(herdr, tasks);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.map((result) => result.outcome.status)).toEqual([
      "completed",
      "launch_failed",
      "completed",
    ]);
    expect(results[1].outcome).toMatchObject({ status: "launch_failed", error: "cannot split" });
  });

  it("never reuses a pane whose cwd differs from the next task", async () => {
    const herdr = createDelegatedHerdr({
      statuses: new Map<string, HerdrAgentStatus[]>([["pane-2", ["working", "idle", "idle"]]]),
      splitPaneIds: ["pane-2"],
      agentStart: ({ paneId }) =>
        paneId === "root-pane"
          ? { error: { code: "launch_rejected", message: "launch denied" } }
          : { result: { pane_id: paneId } },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const starts = recordRpc(herdr, "agent.start", (p) => p.pane_id as string);
    const splits = recordRpc(
      herdr,
      "pane.split",
      (p) => ({ cwd: p.cwd, direction: p.direction, focus: p.focus }),
      starts.rpc,
    );

    // Task 1 fails; task 2 has a different cwd, so it must split its own pane
    // instead of reusing task 1's (which carries task 1's directory).
    const task2 = { ...taskRecord(2, "Second", "beta"), cwd: "/tmp/other-project" };
    const tasks = [taskRecord(1, "First"), task2];
    const delegation = delegate(herdr, tasks, { rpc: splits.rpc });
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

    const results = await delegation;
    expect(results.map((result) => result.outcome.status)).toEqual(["launch_failed", "completed"]);
    expect(starts.records).toEqual(["root-pane", "pane-2"]);
    expect(splits.records).toEqual([
      { cwd: "/tmp/other-project", direction: "right", focus: false },
    ]);
  });

  it("throws when tab creation fails, before any launch", async () => {
    const herdr = createDelegatedHerdr({
      tabCreate: () => ({ error: { code: "internal_error", message: "workspace unreachable" } }),
    });

    await expect(delegate(herdr, [taskRecord(1, "First")])).rejects.toThrow(
      "workspace unreachable",
    );
    expect(herdr.calledMethods).toEqual(["tab.create"]);
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
      // The new tab's root pane is the child's pane; name it after the queue.
      tabCreate: () => ({
        result: { tab: { tab_id: "tab-b" }, root_pane: { pane_id: "pane-b1" } },
      }),
    });

    const delegationA = delegate(herdrA, [taskRecord(1, "Task A")], {
      workspaceId: "shared-workspace",
    });
    await waitForRpcCount(herdrA, 3);
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
    expect(herdrB.calledMethods).toContain("tab.create");
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
    // No tab was created for a pre-aborted delegation.
    expect(herdr.calledMethods).toEqual([]);
  });

  it("stops launching after cancellation while a confirmed session is observing", async () => {
    const herdr = createDelegatedHerdr({ splitPaneIds: ["pane-2"] });
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const tasks = [taskRecord(1, "First"), taskRecord(2, "Second", "beta"), taskRecord(3, "Third")];
    const delegation = delegate(herdr, tasks, { signal: controller.signal });

    // Task 1 is confirmed and its first observation poll has run.
    await waitForRpcCount(herdr, 4);
    controller.abort();
    const results = await delegation;

    expect(results[0].outcome).toMatchObject({
      status: "aborted",
      stage: "observing",
      session: { paneId: "root-pane" },
    });
    expect(results[1].outcome).toEqual({ status: "aborted", stage: "before_launch" });
    expect(results[2].outcome).toEqual({ status: "aborted", stage: "before_launch" });
    expect(herdr.calledMethods).not.toContain("pane.close");
    expect(herdr.calledMethods).not.toContain("agent.stop");
  });

  it("reports launch_indeterminate when cancellation hits an in-flight ambiguous start", async () => {
    const herdr = createScriptedHerdr((request) => {
      if (request.method === "tab.create")
        return { result: { tab: { tab_id: "new-tab" }, root_pane: { pane_id: "root-pane" } } };
      if (request.method === "pane.split")
        return { result: { type: "pane_info", pane: { pane_id: "pane-1" } } };
      if (request.method === "agent.list") return { result: { agents: [] } };
      if (request.method === "agent.start") return { leavePending: true };
      return { result: {} };
    });
    const controller = new AbortController();

    const tasks = [taskRecord(1, "First"), taskRecord(2, "Second", "beta")];
    const delegation = delegate(herdr, tasks, { signal: controller.signal });
    await waitForRpcCount(herdr, 3);
    controller.abort();
    const results = await delegation;

    expect(results[0].outcome).toMatchObject({
      status: "launch_indeterminate",
      possiblePaneId: "root-pane",
    });
    expect(results[1].outcome).toEqual({ status: "aborted", stage: "before_launch" });
  });

  it("starts the timeout at confirmed launch, not when the launch request began", async () => {
    const statuses = new Map<string, HerdrAgentStatus[]>([
      ["root-pane", ["working", "idle", "idle"]],
    ]);
    let startAttempts = 0;
    const herdr = createDelegatedHerdr({
      statuses,
      agentStart: () => {
        startAttempts += 1;
        // Two pane-busy retries delay the confirmed launch to ~500ms.
        if (startAttempts <= 2) return { error: { code: "agent_pane_busy", message: "pane busy" } };
        return { result: { pane_id: "root-pane" } };
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
