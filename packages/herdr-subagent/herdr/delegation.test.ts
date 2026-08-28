import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createScriptedHerdr,
	waitForRpcCount,
	type RpcResponse,
} from "../herdr-test-support.ts";
import {
	executeHerdrDelegation,
	MAX_DELEGATED_TASKS,
	type DelegatedTaskRecord,
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
	agentStart?: (request: { paneId: string }) => RpcResponse;
	tabList?: RpcResponse;
}

/**
 * Scripted Herdr with a shared subagents tab and per-pane status queues.
 * agent.start echoes the target pane back as the new child pane id.
 */
function createDelegatedHerdr(options: DelegatedHerdrOptions = {}) {
	const { statuses = new Map(), splitPaneIds = [], agentStart, tabList } = options;
	let splitCall = 0;
	return createScriptedHerdr((request) => {
		if (request.method === "tab.list") return tabList ?? { result: { tabs: [{ tab_id: "subagent-tab", label: "subagents" }] } };
		if (request.method === "pane.list") return { result: { panes: [{ pane_id: "existing-pane", tab_id: "subagent-tab" }] } };
		if (request.method === "tab.create") {
			return { result: { type: "tab_created", tab: { tab_id: "new-tab" }, root_pane: { pane_id: "root-pane" } } };
		}
		if (request.method === "pane.split") {
			const paneId = splitPaneIds[splitCall++] ?? `split-${splitCall}`;
			return { result: { type: "pane_info", pane: { pane_id: paneId } } };
		}
		if (request.method === "agent.list") return { result: { agents: [] } };
		if (request.method === "agent.start") {
			const paneId = typeof request.params.pane_id === "string" ? request.params.pane_id : "unknown-pane";
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

/** Wrap a herdr's rpc to record agent.start target panes. */
function recordingStartPaneIds(herdr: ReturnType<typeof createScriptedHerdr>): {
	rpc: typeof herdr.rpcCall;
	startPaneIds: string[];
} {
	const startPaneIds: string[] = [];
	const originalRpc = herdr.rpcCall;
	const rpc: typeof originalRpc = (method, params, timeoutMs, signal) => {
		if (method === "agent.start") {
			startPaneIds.push((params as { pane_id: string }).pane_id);
		}
		return originalRpc(method, params, timeoutMs, signal);
	};
	return { rpc, startPaneIds };
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
		expect(results.map((result) => result.outcome.status)).toEqual(["completed", "completed", "completed"]);
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
			["pane-1", ["working", "idle", "idle"]],
		]);
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

		const splitDirections: Array<{ target: unknown; direction: unknown }> = [];
		const originalRpc = herdr.rpcCall;
		const recordingRpc: typeof originalRpc = (method, params, timeoutMs, signal) => {
			if (method === "pane.split") {
				const p = params as { target_pane_id?: unknown; direction?: unknown };
				splitDirections.push({ target: p.target_pane_id, direction: p.direction });
			}
			return originalRpc(method, params, timeoutMs, signal);
		};

		const tasks = [1, 2, 3].map((n) => taskRecord(n, `Task ${n}`, n % 2 ? "alpha" : "beta"));
		const delegation = delegate(herdr, tasks, { rpc: recordingRpc });
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
				if (startCalls === 1) return { error: { code: "launch_rejected", message: "launch denied" } };
				return { result: { pane_id: paneId } };
			},
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { rpc, startPaneIds } = recordingStartPaneIds(herdr);

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
		const statuses = new Map<string, HerdrAgentStatus[]>([
			["pane-2", ["working", "idle", "idle"]],
		]);
		const herdr = createDelegatedHerdr({
			statuses,
			splitPaneIds: ["pane-1", "pane-2"],
			agentStart: ({ paneId }) =>
				paneId === "pane-1" ? { result: {} } : { result: { pane_id: paneId } },
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { rpc, startPaneIds } = recordingStartPaneIds(herdr);

		const tasks = [taskRecord(1, "First"), taskRecord(2, "Second", "beta")];
		const delegation = delegate(herdr, tasks, { rpc });
		for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

		const results = await delegation;
		expect(results.map((result) => result.outcome.status)).toEqual(["launch_indeterminate", "completed"]);
		expect(startPaneIds).toEqual(["pane-1", "pane-2"]);
	});

	it("matches plain and numbered subagents tab labels", async () => {
		// Herdr 0.7 displays numbered tab labels as, for example, "[4] subagents";
		// such a tab must be reused instead of creating a duplicate.
		const statuses = new Map<string, HerdrAgentStatus[]>([
			["pane-1", ["working", "idle", "idle"]],
		]);
		const herdr = createScriptedHerdr((request) => {
			if (request.method === "tab.list") return { result: { tabs: [{ tab_id: "numbered-tab", label: "[4] subagents" }] } };
			if (request.method === "pane.list") return { result: { panes: [{ pane_id: "numbered-pane", tab_id: "numbered-tab" }] } };
			if (request.method === "pane.split") return { result: { type: "pane_info", pane: { pane_id: "pane-1" } } };
			if (request.method === "agent.list") return { result: { agents: [] } };
			if (request.method === "agent.start") return { result: { pane_id: "pane-1" } };
			if (request.method === "agent.get") return { result: { agent: { agent_status: statuses.get("pane-1")?.shift() ?? "working" } } };
			return { result: {} };
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
		const statuses = new Map<string, HerdrAgentStatus[]>([
			["pane-2", ["working", "idle", "idle"]],
			["pane-3", ["working", "idle", "idle"]],
		]);
		let splitCalls = 0;
		const herdr = createScriptedHerdr((request) => {
			if (request.method === "tab.list") return { result: { tabs: [{ tab_id: "subagent-tab", label: "subagents" }] } };
			if (request.method === "pane.list") return { result: { panes: [{ pane_id: "existing-pane", tab_id: "subagent-tab" }] } };
			if (request.method === "pane.split") {
				splitCalls += 1;
				// The first split (task 1) fails; later siblings still launch.
				if (splitCalls === 1) return { error: { code: "split_failed", message: "cannot split" } };
				const paneId = splitCalls === 2 ? "pane-2" : "pane-3";
				return { result: { type: "pane_info", pane: { pane_id: paneId } } };
			}
			if (request.method === "agent.list") return { result: { agents: [] } };
			if (request.method === "agent.start") return { result: { pane_id: (request.params as { pane_id: string }).pane_id } };
			if (request.method === "agent.get") {
				const target = (request.params as { target: string }).target;
				return { result: { agent: { agent_status: statuses.get(target)?.shift() ?? "working" } } };
			}
			return { result: {} };
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
		const statuses = new Map<string, HerdrAgentStatus[]>([
			["pane-2", ["working", "idle", "idle"]],
		]);
		const herdr = createDelegatedHerdr({
			statuses,
			splitPaneIds: ["pane-1", "pane-2"],
			agentStart: ({ paneId }) =>
				paneId === "pane-1"
					? { error: { code: "launch_rejected", message: "launch denied" } }
					: { result: { pane_id: paneId } },
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { rpc, startPaneIds } = recordingStartPaneIds(herdr);

		const splitCwds: Array<string | undefined> = [];
		const recordingRpc: typeof rpc = (method, params, timeoutMs, signal) => {
			if (method === "pane.split") {
				splitCwds.push((params as { cwd?: string }).cwd);
			}
			return rpc(method, params, timeoutMs, signal);
		};

		// Task 1 fails; task 2 has a different cwd, so it must split its own pane
		// instead of reusing task 1's (which carries task 1's directory).
		const task2 = { ...taskRecord(2, "Second", "beta"), cwd: "/tmp/other-project" };
		const tasks = [taskRecord(1, "First"), task2];
		const delegation = delegate(herdr, tasks, { rpc: recordingRpc });
		for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(800);

		const results = await delegation;
		expect(results.map((result) => result.outcome.status)).toEqual(["launch_failed", "completed"]);
		expect(startPaneIds).toEqual(["pane-1", "pane-2"]);
		expect(splitCwds).toEqual(["/tmp/project", "/tmp/other-project"]);
	});

	it("throws when shared workspace provisioning fails, before any launch", async () => {
		const herdr = createDelegatedHerdr({
			tabList: { error: { code: "internal_error", message: "workspace unreachable" } },
		});

		await expect(delegate(herdr, [taskRecord(1, "First")])).rejects.toThrow("workspace unreachable");
		expect(herdr.calledMethods).toEqual(["tab.list"]);
		expect(herdr.calledMethods).not.toContain("agent.start");
	});

	it("rejects more than eight valid tasks before contacting Herdr", async () => {
		const herdr = createDelegatedHerdr();
		const tasks = Array.from({ length: MAX_DELEGATED_TASKS + 1 }, (_, i) => taskRecord(i + 1, `Task ${i + 1}`));

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

		const delegationA = delegate(herdrA, [taskRecord(1, "Task A")], { workspaceId: "shared-workspace" });
		await waitForRpcCount(herdrA, 5);
		const delegationB = delegate(herdrB, [taskRecord(1, "Task B", "beta")], { workspaceId: "shared-workspace" });
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
		const results = await delegate(herdr, [taskRecord(1, "First"), taskRecord(2, "Second", "beta")], {
			signal: AbortSignal.abort(),
		});

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
			if (request.method === "tab.list") return { result: { tabs: [{ tab_id: "subagent-tab", label: "subagents" }] } };
			if (request.method === "pane.list") return { result: { panes: [{ pane_id: "existing-pane", tab_id: "subagent-tab" }] } };
			if (request.method === "pane.split") return { result: { type: "pane_info", pane: { pane_id: "pane-1" } } };
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

		expect(results[0].outcome).toMatchObject({ status: "launch_indeterminate", possiblePaneId: "pane-1" });
		expect(results[1].outcome).toEqual({ status: "aborted", stage: "before_launch" });
	});

	it("starts the timeout at confirmed launch, not when the launch request began", async () => {
		const statuses = new Map<string, HerdrAgentStatus[]>([
			["pane-1", ["working", "idle", "idle"]],
		]);
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
