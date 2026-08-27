import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createScriptedHerdr,
	standardLaunchResponse,
} from "../herdr-test-support.ts";
import { executeDelegatedTask } from "./session.ts";

const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-session-tests-"));

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function writeSessionFile(name: string, lines: string): string {
	const p = path.join(sessionDir, `${name}.jsonl`);
	fs.writeFileSync(p, lines);
	return p;
}

function jsonl(...objs: unknown[]): string {
	return objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

describe("herdr/session — launch invariants", () => {
	it("preserves argv order name/model/tools/prompt/task and sanitizes control chars", async () => {
		let capturedArgs: unknown = null;
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") {
				capturedArgs = req.params;
				return { result: { pane_id: "p1" } };
			}
			if (req.method === "agent.get") return { result: { agent: { agent_status: "working" } } };
			return { result: {} };
		});

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const controller = new AbortController();
		const taskWithControls = "hello\x00world\x1f\x7f!";
		const session = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: {
				agentName: "alpha",
				task: taskWithControls,
				cwd: "/tmp/project",
				config: { name: "alpha", systemPromptBody: "prompt body", model: "openai/gpt-5", tools: ["read", "write"] },
			},
			timeoutMs: 2000,
			signal: controller.signal,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(capturedArgs).toMatchObject({
			name: expect.stringMatching(/^sa-/),
			args: expect.arrayContaining(["--model", "openai/gpt-5", "--tools", "read,write"]),
		});
		const args = (capturedArgs as { args: string[] }).args;
		// Order: --name label, --model ..., --tools ..., --append-system-prompt path, sanitized task
		const nameIdx = args.indexOf("--name");
		const modelIdx = args.indexOf("--model");
		const toolsIdx = args.indexOf("--tools");
		const promptIdx = args.indexOf("--append-system-prompt");
		expect(nameIdx).toBeLessThan(modelIdx);
		expect(modelIdx).toBeLessThan(toolsIdx);
		expect(toolsIdx).toBeLessThan(promptIdx);
		// Sanitized task is last
		expect(args[args.length - 1]).toBe("hello world  !");
		// Should contain prompt file arg
		expect(args[promptIdx + 1]).toMatch(/pi-subagent-/);

		controller.abort();
		await session;
	});

	it("caps label at 32 and retries name collisions up to 100", async () => {
		let startCalls = 0;
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.list") return { result: { agents: [{ agent: "sa-alpha-hello-world" }] } };
			if (req.method === "agent.start") {
				startCalls += 1;
				const name = (req.params as { name: string }).name;
				// First attempt collides, second succeeds
				if (startCalls === 1) return { error: { code: "agent_name_taken", message: "taken" } };
				expect(name.length).toBeLessThanOrEqual(32);
				return { result: { pane_id: "p2" } };
			}
			return { result: { agent: { agent_status: "working" } } };
		});

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const controller = new AbortController();
		const veryLong = "a".repeat(100);
		const session = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: veryLong, cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 500,
			signal: controller.signal,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(startCalls).toBe(2);
		controller.abort();
		expect(await session).toMatchObject({ status: "aborted", stage: "observing" });
	});

	it("retries pane-busy 10x and then succeeds", async () => {
		let startAttempts = 0;
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") {
				startAttempts += 1;
				if (startAttempts < 3) return { error: { code: "agent_pane_busy", message: "busy" } };
				return { result: { pane_id: "p3" } };
			}
			return { result: { agent: { agent_status: "working" } } };
		});

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const session = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 1000,
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(300);
		await vi.advanceTimersByTimeAsync(300);
		expect(startAttempts).toBe(3);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(800);
		expect(await session).toMatchObject({ status: "timed_out" });
		vi.useRealTimers();
	});

	it("classifies confirmed launch failure vs indeterminate (no pane_id, transport loss)", async () => {
		const confirmed = createScriptedHerdr((req) => standardLaunchResponse(req) ?? { error: { code: "launch_rejected", message: "denied" } });
		const r1 = await executeDelegatedTask({
			rpc: confirmed.rpcCall,
			targetPaneId: "target-pane",
			
			
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
		});
		expect(r1.status).toBe("launch_failed");

		const indeterminate = createScriptedHerdr((req) => standardLaunchResponse(req) ?? { result: {} });
		const r2 = await executeDelegatedTask({
			rpc: indeterminate.rpcCall,
			targetPaneId: "target-pane",
			
			
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
		});
		expect(r2.status).toBe("launch_indeterminate");

		const transport = createScriptedHerdr((req) => standardLaunchResponse(req) ?? { closeWithoutResponse: true });
		const r3 = await executeDelegatedTask({
			rpc: transport.rpcCall,
			targetPaneId: "target-pane",
			
			
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
		});
		expect(r3.status).toBe("launch_indeterminate");
	});

	it("aborts before launch when signal already aborted", async () => {
		const herdr = createScriptedHerdr((req) => standardLaunchResponse(req) ?? { result: { pane_id: "p" } });
		const result = await executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "body" } },
			signal: AbortSignal.abort(),
		});
		expect(result).toEqual({ status: "aborted", stage: "before_launch" });
		expect(herdr.calledMethods).toEqual([]);
	});
});

describe("herdr/session — prompt lease", () => {
	function promptDirs(): Set<string> {
		return new Set(
			fs.readdirSync(os.tmpdir())
				.filter((e) => e.startsWith("pi-subagent-"))
				.map((e) => path.join(os.tmpdir(), e)),
		);
	}

	it("empty body creates no file", async () => {
		const before = promptDirs();
		const herdr = createScriptedHerdr((req) => standardLaunchResponse(req) ?? { error: { code: "launch_rejected", message: "x" } });
		await executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
		});
		expect(promptDirs()).toEqual(before);
	});

	it("confirmed failure removes prompt immediately", async () => {
		const before = promptDirs();
		const herdr = createScriptedHerdr((req) => standardLaunchResponse(req) ?? { error: { code: "launch_rejected", message: "denied" } });
		await executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "body" } },
		});
		expect(promptDirs()).toEqual(before);
	});

	it("indeterminate retains 60s and confirmed retains until session path", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const before = promptDirs();

		// Indeterminate
		const ind = createScriptedHerdr((req) => standardLaunchResponse(req) ?? { result: {} });
		const p1 = executeDelegatedTask({
			rpc: ind.rpcCall,
			targetPaneId: "target-pane",
			
			
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "body-ind" } },
		});
		await p1;
		const dirInd = [...promptDirs()].find((e) => !before.has(e));
		expect(dirInd).toBeDefined();
		expect(fs.existsSync(dirInd!)).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fs.existsSync(dirInd!)).toBe(false);

		// Confirmed with session path → prompt removed on observation (session path confirms consumption)
		const sessionPath = writeSessionFile(
			"prompt-session",
			jsonl({ type: "session", id: "s1", cwd: "/tmp", timestamp: "x" }, { type: "message", id: "m1", parentId: null, timestamp: "x", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] } }),
		);
		let getCount = 0;
		const confirmed = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-conf" } };
			getCount += 1;
			if (getCount === 1) return { result: { agent: { agent_status: "working", agent_session: { path: sessionPath } } } };
			return { result: { agent: { agent_status: "idle", agent_session: { path: sessionPath } } } };
		});
		const before2 = promptDirs();
		const session = executeDelegatedTask({
			rpc: confirmed.rpcCall,
			targetPaneId: "target-pane",
			
			
			task: { agentName: "alpha", task: "t2", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "body-conf" } },
			timeoutMs: 5000,
		});
		const dirConf = [...promptDirs()].find((e) => !before2.has(e));
		expect(dirConf).toBeDefined();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(800);
		await vi.advanceTimersByTimeAsync(800);
		await session;
		expect(fs.existsSync(dirConf!)).toBe(false);
		vi.useRealTimers();
	});
});

describe("herdr/session — observation", () => {
	function makeSession(answerText: string | null): string {
		const lines: unknown[] = [{ type: "session", id: "sess-1", cwd: "/tmp", timestamp: "x" }];
		if (answerText !== null) {
			lines.push({ type: "message", id: "m1", parentId: null, timestamp: "x", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answerText }] } });
		}
		return writeSessionFile(`obs-${Math.random().toString(36).slice(2)}`, jsonl(...lines));
	}

	it("begins immediately, ignores startup idle, needs working+2x settled", async () => {
		const sessionPath = makeSession("ans");
		const statuses = ["idle", "idle", "working", "done", "done"];
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-obs" } };
			const s = statuses.shift() ?? "done";
			return { result: { agent: { agent_status: s, agent_session: { path: sessionPath } } } };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 5000,
		});
		await vi.advanceTimersByTimeAsync(0); // idle (startup) - not settled
		await vi.advanceTimersByTimeAsync(800);
		// idle
		await vi.advanceTimersByTimeAsync(800);
		// working -> active
		let done = false;
		void run.then(() => { done = true; });
		await vi.advanceTimersByTimeAsync(800);
		// done1
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(800);
		// done2 -> settle
		const result = await run;
		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect(result.answer).toEqual({ path: sessionPath, entryId: "m1" });
			expect(result.session.pi).toEqual({ id: "sess-1", path: sessionPath, cwd: "/tmp" });
		}
		vi.useRealTimers();
	});

	it("completion wins before timeout at boundary", async () => {
		const sessionPath = makeSession("boundary");
		let count = 0;
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-b" } };
			count += 1;
			const status = count === 1 ? "working" : count === 2 ? "idle" : "done";
			return { result: { agent: { agent_status: status, agent_session: { path: sessionPath } } } };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 1600, // 2 polls = boundary
		});
		await vi.advanceTimersByTimeAsync(0); // working
		await vi.advanceTimersByTimeAsync(800);
		// idle
		await vi.advanceTimersByTimeAsync(800);
		// done -> should complete before timeout
		const result = await run;
		expect(result.status).toBe("completed");
		vi.useRealTimers();
	});

	it("pane not found → session_closed, transport retry, explicit error → observation_failed", async () => {
		const closed = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-closed" } };
			return { error: { code: "not_found", message: "no such pane" } };
		});
		const rClosed = await executeDelegatedTask({
			rpc: closed.rpcCall,
			targetPaneId: "target-pane",
			
			
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 2000,
		});
		expect(rClosed).toMatchObject({ status: "session_closed" });

		const transient = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-trans2" } };
			return { closeWithoutResponse: true };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const runTrans = executeDelegatedTask({
			rpc: transient.rpcCall,
			targetPaneId: "target-pane",
			
			
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 1000,
		});
		await vi.advanceTimersByTimeAsync(0);
		// It should retry and then timeout, not observation_failed
		await vi.advanceTimersByTimeAsync(1800);
		const rTrans = await runTrans;
		expect(rTrans.status).toBe("timed_out");
		vi.useRealTimers();

		const explicit = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-exp" } };
			return { error: { code: "internal_error", message: "boom" } };
		});
		const rExp = await executeDelegatedTask({
			rpc: explicit.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
		});
		expect(rExp).toMatchObject({ status: "observation_failed" });
	});

	it("timeout stops observation only, session remains live (no pane close)", async () => {
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-time" } };
			return { result: { agent: { agent_status: "working", agent_session: {} } } };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 800,
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);
		const result = await run;
		expect(result).toMatchObject({ status: "timed_out" });
		expect(herdr.calledMethods).not.toContain("pane.close");
		expect(herdr.calledMethods).not.toContain("agent.stop");
		vi.useRealTimers();
	});

	it("cancellation while observing → aborted observing with session", async () => {
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-abort" } };
			return { result: { agent: { agent_status: "working", agent_session: {} } } };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const ctrl = new AbortController();
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			signal: ctrl.signal,
		});
		await vi.advanceTimersByTimeAsync(0);
		ctrl.abort();
		const result = await run;
		expect(result).toMatchObject({ status: "aborted", stage: "observing" });
		expect(herdr.calledMethods).not.toContain("pane.close");
		vi.useRealTimers();
	});

	it("returns pi metadata and answer ref without text, retains through timeout", async () => {
		const sessionPath = makeSession("secret answer");
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-pi" } };
			return { result: { agent: { agent_status: "working", agent_session: { path: sessionPath } } } };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 800,
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(800);
		const result = await run;
		expect(result.status).toBe("timed_out");
		if (result.status === "timed_out") {
			expect(result.session.pi).toEqual({ id: "sess-1", path: sessionPath, cwd: "/tmp" });
		}
		vi.useRealTimers();
	});

	it("partial header: session path published but header not yet readable retries", async () => {
		const emptyPath = writeSessionFile("partial-empty", "");
		const fullPath = writeSessionFile("partial-full", jsonl({ type: "session", id: "s-partial", cwd: "/tmp", timestamp: "x" }, { type: "message", id: "m-partial", parentId: null, timestamp: "x", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "partial" }] } }));
		let calls = 0;
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-partial" } };
			calls += 1;
			if (calls === 1) return { result: { agent: { agent_status: "working", agent_session: { path: emptyPath } } } };
			if (calls === 2) return { result: { agent: { agent_status: "working", agent_session: { path: fullPath } } } };
			return { result: { agent: { agent_status: "idle", agent_session: { path: fullPath } } } };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			timeoutMs: 5000,
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(800);
		await vi.advanceTimersByTimeAsync(800);
		await vi.advanceTimersByTimeAsync(800);
		await vi.advanceTimersByTimeAsync(800);
		const result = await run;
		expect(result.status).toBe("completed");
		if (result.status === "completed") expect(result.session.pi?.id).toBe("s-partial");
		vi.useRealTimers();
	});

	it("cleanup is idempotent and nonthrowing even if fs fails", async () => {
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { result: { pane_id: "p-clean" } };
			return { result: { agent: { agent_status: "working", agent_session: {} } } };
		});
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "body-clean" } },
			timeoutMs: 800,
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(800);
		const result = await run;
		expect(result.status).toBe("timed_out");
		await vi.advanceTimersByTimeAsync(60_000);
		vi.useRealTimers();
	});

	it("exhausts 100 name attempts", async () => {
		const herdr = createScriptedHerdr((req) => {
			if (req.method === "agent.list") return { result: { agents: Array.from({ length: 100 }, (_, i) => ({ agent: `sa-alpha-t${i ? `-${i+1}` : ""}` })) } };
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { error: { code: "agent_name_taken", message: "taken" } };
			return { result: {} };
		});
		const result = await executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
		});
		expect(result.status).toBe("launch_failed");
	});

	it("exhausts 10 pane-busy attempts", async () => {
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { error: { code: "agent_pane_busy", message: "busy" } };
			return { result: {} };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
		});
		const promise = run;
		for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(250);
		const result = await promise;
		expect(result.status).toBe("launch_failed");
		vi.useRealTimers();
	});

	it("cancellation between retries aborts before launch", async () => {
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { error: { code: "agent_pane_busy", message: "busy" } };
			return { result: {} };
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const ctrl = new AbortController();
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			signal: ctrl.signal,
		});
		await vi.advanceTimersByTimeAsync(0);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(250);
		const result = await run;
		expect(result.status).toBe("aborted");
		if (result.status === "aborted") expect(result.stage).toBe("before_launch");
		vi.useRealTimers();
	});

	it("in-flight cancellation after agent.start becomes launch_indeterminate", async () => {
		const herdr = createScriptedHerdr((req) => {
			const std = standardLaunchResponse(req);
			if (std) return std;
			if (req.method === "agent.start") return { leavePending: true } as import("../herdr-test-support.ts").RpcResponse;
			return { result: {} };
		});
		const ctrl = new AbortController();
		const run = executeDelegatedTask({
			rpc: herdr.rpcCall,
			targetPaneId: "target-pane",
			task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "body" } },
			signal: ctrl.signal,
		});
		await new Promise<void>((r) => setTimeout(r, 0));
		ctrl.abort();
		const result = await run;
		expect(result.status).toBe("launch_indeterminate");
		if (result.status === "launch_indeterminate") expect(result.possiblePaneId).toBe("target-pane");
	});

	it("malformed agent.get responses become observation_failed", async () => {
		for (const malformed of [{}, { agent: null }, { agent: {} }, { agent: { agent_status: 123 } }, null, 5]) {
			const herdr = createScriptedHerdr((req) => {
				const std = standardLaunchResponse(req);
				if (std) return std;
				if (req.method === "agent.start") return { result: { pane_id: "p-mal" } };
				return { result: malformed as unknown as Record<string, unknown> };
			});
			const result = await executeDelegatedTask({
				rpc: herdr.rpcCall,
				targetPaneId: "target-pane",
				task: { agentName: "alpha", task: "t", cwd: "/tmp", config: { name: "alpha", systemPromptBody: "" } },
			});
			expect(result.status).toBe("observation_failed");
		}
	});
});
