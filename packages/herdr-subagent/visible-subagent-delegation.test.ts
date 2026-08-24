import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	advanceObservationPoll,
	createScriptedHerdrTracker,
	runnerOptionsFor,
	standardLaunchResponse,
	waitForRpcCount,
	type RpcResponse,
	type ScriptedHerdr,
} from "./herdr-test-support.js";
import { runSubagents } from "./subagent-runner.js";

type HerdrAgentStatus = "idle" | "done" | "working" | "blocked" | "unknown";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const herdrServers = createScriptedHerdrTracker();
const ACTIVE_STATUSES: HerdrAgentStatus[] = ["working", "blocked"];
let agentDir: string;
let sessionDir: string;

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-subagent-agents-"));
	sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-subagent-sessions-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const agentsDir = path.join(agentDir, "agents");
	fs.mkdirSync(agentsDir);
	for (const name of ["alpha", "beta"]) {
		fs.writeFileSync(
			path.join(agentsDir, `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent\n---\n`,
		);
	}
	fs.writeFileSync(
		path.join(agentsDir, "prompted.md"),
		"---\nname: prompted\ndescription: prompted agent\n---\nFollow this system prompt.\n",
	);
});

afterEach(async () => {
	vi.useRealTimers();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(sessionDir, { recursive: true, force: true });
	await herdrServers.closeAll();
	vi.restoreAllMocks();
});

function writeSessionAnswer(name: string, answerText: string): string {
	const sessionPath = path.join(sessionDir, `${name}.jsonl`);
	fs.writeFileSync(sessionPath, `${JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: answerText }],
		},
	})}\n`);
	return sessionPath;
}

function observationResponse(status: HerdrAgentStatus, sessionPath?: string): RpcResponse {
	return {
		result: {
			agent: {
				agent_status: status,
				agent_session: sessionPath ? { path: sessionPath } : undefined,
			},
		},
	};
}

function delegate(
	herdr: ScriptedHerdr,
	tasks: Array<{ agent: string; task: string }>,
	signal?: AbortSignal,
	timeout?: number,
): ReturnType<typeof runSubagents> {
	return runSubagents(
		undefined,
		runnerOptionsFor(herdr),
		{ tasks, timeout },
		signal,
		undefined,
	);
}

function resultText(result: Awaited<ReturnType<typeof runSubagents>>): string {
	return result.content[0].text;
}

function promptDirectories(): Set<string> {
	return new Set(
		fs.readdirSync(os.tmpdir())
			.filter((entry) => entry.startsWith("pi-subagent-"))
			.map((entry) => path.join(os.tmpdir(), entry)),
	);
}

function findNewPromptDirectory(previousDirectories: Set<string>): string {
	const promptDirectory = [...promptDirectories()].find((entry) => !previousDirectories.has(entry));
	if (!promptDirectory) throw new Error("launch did not create a prompt directory");
	return promptDirectory;
}

describe("visible subagent delegation presentation", () => {
	it.each([
		{ answerText: "A concise answer.", expected: "A concise answer." },
		{ answerText: null, expected: "subagent produced no final answer; inspect pane child-pane" },
	])("presents a completed single delegated task without a wrapper", async ({ answerText, expected }) => {
		const statuses: HerdrAgentStatus[] = ["working", "idle", "idle"];
		const sessionPath = answerText === null ? undefined : writeSessionAnswer("single", answerText);
		const herdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") return { result: { pane_id: "child-pane" } };
			return observationResponse(statuses.shift() ?? "idle", sessionPath);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

		const delegation = delegate(herdr, [{ agent: "alpha", task: "Review this" }]);
		await waitForRpcCount(herdr, 6);
		await advanceObservationPoll(herdr, 7);
		await advanceObservationPoll(herdr, 8);

		await expect(delegation).resolves.toMatchObject({
			content: [{ type: "text", text: expected }],
		});
	});

	it("presents multiple delegated task outcomes in request order when they settle out of order", async () => {
		const sessionPaths = {
			"child-alpha": writeSessionAnswer("alpha", "first answer"),
			"child-beta": writeSessionAnswer("beta", "second answer"),
		};
		const statuses = new Map<string, HerdrAgentStatus[]>([
			["child-alpha", ["working", "working", "idle", "idle"]],
			["child-beta", ["working", "idle", "idle"]],
		]);
		let launchedCount = 0;
		const herdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") {
				launchedCount += 1;
				return { result: { pane_id: launchedCount === 1 ? "child-alpha" : "child-beta" } };
			}
			const target = typeof request.params.target === "string" ? request.params.target : "";
			const targetStatuses = statuses.get(target);
			const sessionPath = target === "child-alpha"
				? sessionPaths["child-alpha"]
				: target === "child-beta"
					? sessionPaths["child-beta"]
					: undefined;
			return observationResponse(targetStatuses?.shift() ?? "idle", sessionPath);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

		const delegation = delegate(herdr, [
			{ agent: "alpha", task: "First" },
			{ agent: "beta", task: "Second" },
		]);
		await waitForRpcCount(herdr, 5);
		await vi.advanceTimersByTimeAsync(250);
		await waitForRpcCount(herdr, 10);
		await advanceObservationPoll(herdr, 12);
		await advanceObservationPoll(herdr, 14);
		await advanceObservationPoll(herdr, 15);

		const text = resultText(await delegation);
		expect(text.indexOf("first answer")).toBeLessThan(text.indexOf("second answer"));
	});
});

describe("visible subagent launch outcomes", () => {
	it.each([
		{
			name: "an explicit launch rejection",
			launchResponse: { error: { code: "launch_rejected", message: "launch denied" } } satisfies RpcResponse,
			expectedText: "spawn failed: launch denied",
		},
		{
			name: "transport loss after the launch request",
			launchResponse: { closeWithoutResponse: true } satisfies RpcResponse,
			expectedText: "subagent launch state is unknown; inspect the subagents tab.",
		},
		{
			name: "a launch response without a pane ID",
			launchResponse: { result: {} } satisfies RpcResponse,
			expectedText: "subagent launch state is unknown; inspect the subagents tab.",
		},
	])("classifies $name", async ({ launchResponse, expectedText }) => {
		const herdr = await herdrServers.start((request) =>
			standardLaunchResponse(request) ?? launchResponse);

		const result = await delegate(herdr, [{ agent: "alpha", task: "Review this" }]);

		expect(resultText(result)).toBe(expectedText);
	});

	it("distinguishes an explicit rejection from a launch RPC timeout", async () => {
		const herdr = await herdrServers.start((request) =>
			standardLaunchResponse(request) ?? { leavePending: true });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const delegation = delegate(herdr, [{ agent: "alpha", task: "Review this" }]);
		await waitForRpcCount(herdr, 5);

		await vi.advanceTimersByTimeAsync(15_000);

		expect(resultText(await delegation)).toBe(
			"subagent launch state is unknown; inspect the subagents tab.",
		);
	});
});

describe("delegated task observation", () => {
	it.each(ACTIVE_STATUSES)(
		"ignores startup idle and settles after %s activity followed by two settled observations",
		async (activeStatus) => {
			const statuses: HerdrAgentStatus[] = ["idle", "idle", activeStatus, "done", "done"];
			const herdr = await herdrServers.start((request) => {
				const standardResponse = standardLaunchResponse(request);
				if (standardResponse) return standardResponse;
				if (request.method === "agent.start") return { result: { pane_id: "child-pane" } };
				return observationResponse(statuses.shift() ?? "done");
			});
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const delegation = delegate(herdr, [{ agent: "alpha", task: "Review this" }]);
			let settled = false;
			void delegation.then(() => {
				settled = true;
			});

			await waitForRpcCount(herdr, 6);
			await advanceObservationPoll(herdr, 7);
			await advanceObservationPoll(herdr, 8);
			expect(settled).toBe(false);
			await advanceObservationPoll(herdr, 9);
			await advanceObservationPoll(herdr, 10);

			await expect(delegation).resolves.toMatchObject({
				content: [{ type: "text", text: "subagent produced no final answer; inspect pane child-pane" }],
			});
		},
	);

	it("lets completion win when the second settled observation occurs at the timeout boundary", async () => {
		let observationCount = 0;
		const sessionPath = writeSessionAnswer("boundary", "boundary answer");
		const herdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") return { result: { pane_id: "boundary-pane" } };
			observationCount += 1;
			const status = observationCount <= 74 ? "working" : observationCount === 75 ? "idle" : "done";
			return observationResponse(status, sessionPath);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const delegation = delegate(
			herdr,
			[{ agent: "alpha", task: "Review this" }],
			undefined,
			1,
		);
		await waitForRpcCount(herdr, 6);
		for (let rpcCount = 7; rpcCount <= 81; rpcCount++) {
			await advanceObservationPoll(herdr, rpcCount);
		}

		expect(resultText(await delegation)).toBe("boundary answer");
	});

	it("distinguishes pane closure from a recoverable non-closure observation failure", async () => {
		const closedHerdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") return { result: { pane_id: "closed-pane" } };
			return { error: { code: "not_found", message: "no such pane" } };
		});
		const closed = await delegate(closedHerdr, [{ agent: "alpha", task: "Review this" }]);

		const transientResponses: RpcResponse[] = [
			{ error: { code: "socket_busy", message: "temporarily unavailable" } },
			observationResponse("working"),
			observationResponse("idle"),
			observationResponse("idle"),
		];
		const transientHerdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") return { result: { pane_id: "recovering-pane" } };
			return transientResponses.shift() ?? observationResponse("idle");
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const recovered = delegate(transientHerdr, [{ agent: "alpha", task: "Review this" }]);
		await waitForRpcCount(transientHerdr, 6);
		await advanceObservationPoll(transientHerdr, 7);
		await advanceObservationPoll(transientHerdr, 8);
		await advanceObservationPoll(transientHerdr, 9);

		expect(resultText(closed)).toBe("(pane closed-pane closed before completion)");
		expect(resultText(await recovered)).toBe(
			"subagent produced no final answer; inspect pane recovering-pane",
		);
	});

	it("timeout stops observation without closing the visible subagent session", async () => {
		const herdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") return { result: { pane_id: "timed-out-pane" } };
			return observationResponse("working");
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const delegation = delegate(
			herdr,
			[{ agent: "alpha", task: "Review this" }],
			undefined,
			1,
		);
		await waitForRpcCount(herdr, 6);
		for (let rpcCount = 7; rpcCount <= 81; rpcCount++) {
			await advanceObservationPoll(herdr, rpcCount);
		}

		expect(resultText(await delegation)).toBe(
			"delegation timed out after 1m, pane timed-out-pane still live",
		);
		expect(herdr.methods).not.toContain("pane.close");
		expect(herdr.methods).not.toContain("agent.stop");
	});

	it("distinguishes cancellation before launch from cancellation while observing a visible subagent session", async () => {
		const beforeLaunchHerdr = await herdrServers.start((request) =>
			standardLaunchResponse(request) ?? { result: { pane_id: "unused-pane" } });
		const beforeLaunch = await delegate(
			beforeLaunchHerdr,
			[{ agent: "alpha", task: "First" }],
			AbortSignal.abort(),
		);

		const observingHerdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") return { result: { pane_id: "live-pane" } };
			return observationResponse("working");
		});
		const controller = new AbortController();
		const whileObserving = delegate(
			observingHerdr,
			[{ agent: "alpha", task: "Second" }],
			controller.signal,
		);
		await waitForRpcCount(observingHerdr, 6);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort();
		const observingResult = await whileObserving;

		expect(resultText(beforeLaunch)).toContain("before this subagent launched");
		expect(resultText(beforeLaunch)).not.toContain("still running");
		expect(resultText(observingResult)).toContain("pane live-pane");
		expect(resultText(observingResult)).toContain("still running");
		expect(beforeLaunchHerdr.methods).toEqual([]);
		expect(observingHerdr.methods).not.toContain("pane.close");
		expect(observingHerdr.methods).not.toContain("agent.stop");
	});
});

describe("startup prompt resource lifetime", () => {
	it("removes prompt resources immediately after confirmed launch failure", async () => {
		const promptDirectoriesBeforeLaunch = promptDirectories();
		const herdr = await herdrServers.start((request) =>
			standardLaunchResponse(request) ?? {
				error: { code: "launch_rejected", message: "launch denied" },
			});

		await delegate(herdr, [{ agent: "prompted", task: "Review this" }]);

		expect(promptDirectories()).toEqual(promptDirectoriesBeforeLaunch);
	});

	it("releases a retained prompt after the child publishes its Pi session", async () => {
		const promptDirectoriesBeforeLaunch = promptDirectories();
		const statuses: HerdrAgentStatus[] = ["working", "idle", "idle"];
		const sessionPath = writeSessionAnswer("prompted", "prompted answer");
		const herdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") return { result: { pane_id: "prompted-pane" } };
			return observationResponse(statuses.shift() ?? "idle", sessionPath);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const delegation = delegate(herdr, [{ agent: "prompted", task: "Review this" }]);
		await waitForRpcCount(herdr, 6);
		const promptDirectory = findNewPromptDirectory(promptDirectoriesBeforeLaunch);
		expect(fs.existsSync(promptDirectory)).toBe(true);
		await advanceObservationPoll(herdr, 7);
		await advanceObservationPoll(herdr, 8);
		await delegation;

		expect(fs.existsSync(promptDirectory)).toBe(false);
	});

	it("releases a confirmed launch prompt through the 60-second fallback", async () => {
		const promptDirectoriesBeforeLaunch = promptDirectories();
		const herdr = await herdrServers.start((request) => {
			const standardResponse = standardLaunchResponse(request);
			if (standardResponse) return standardResponse;
			if (request.method === "agent.start") return { result: { pane_id: "live-prompted-pane" } };
			return { leavePending: true };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const controller = new AbortController();
		const delegation = delegate(
			herdr,
			[{ agent: "prompted", task: "Review this" }],
			controller.signal,
		);
		await waitForRpcCount(herdr, 6);
		const promptDirectory = findNewPromptDirectory(promptDirectoriesBeforeLaunch);
		expect(fs.existsSync(promptDirectory)).toBe(true);
		controller.abort();
		await delegation;
		expect(fs.existsSync(promptDirectory)).toBe(true);

		await vi.advanceTimersByTimeAsync(60_000);

		expect(fs.existsSync(promptDirectory)).toBe(false);
	});

	it("releases an indeterminate launch prompt through the 60-second fallback", async () => {
		const promptDirectoriesBeforeLaunch = promptDirectories();
		const herdr = await herdrServers.start((request) =>
			standardLaunchResponse(request) ?? { result: {} });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		await delegate(herdr, [{ agent: "prompted", task: "Review this" }]);
		const promptDirectory = findNewPromptDirectory(promptDirectoriesBeforeLaunch);
		expect(fs.existsSync(promptDirectory)).toBe(true);

		await vi.advanceTimersByTimeAsync(60_000);

		expect(fs.existsSync(promptDirectory)).toBe(false);
	});
});
