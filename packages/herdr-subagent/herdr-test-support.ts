import * as fs from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, vi } from "vitest";
import { discoverUserAgents } from "./agents.js";
import { HerdrBackend } from "./herdr-backend.js";
import type { RunnerOptions } from "./subagent-runner.js";

export interface RpcRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export type RpcResponse =
	| { result: unknown }
	| { error: { code?: string | number; message: string } }
	| { closeWithoutResponse: true }
	| { leavePending: true };

export interface ScriptedHerdr {
	socketPath: string;
	methods: string[];
	close(): Promise<void>;
}

export interface ScriptedHerdrTracker {
	start(respondToRequest: (request: RpcRequest) => RpcResponse): Promise<ScriptedHerdr>;
	closeAll(): Promise<void>;
}

function isRpcRequest(value: unknown): value is RpcRequest {
	return typeof value === "object" && value !== null &&
		"id" in value && typeof value.id === "string" &&
		"method" in value && typeof value.method === "string" &&
		"params" in value && typeof value.params === "object" && value.params !== null;
}

async function startScriptedHerdr(
	respondToRequest: (request: RpcRequest) => RpcResponse,
): Promise<ScriptedHerdr> {
	const socketPath = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "scripted-herdr-")),
		"herdr.sock",
	);
	const methods: string[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const parsed: unknown = JSON.parse(line);
				if (!isRpcRequest(parsed)) {
					socket.end();
					continue;
				}
				methods.push(parsed.method);
				const response = respondToRequest(parsed);
				if ("closeWithoutResponse" in response) {
					socket.end();
				} else if (!("leavePending" in response)) {
					socket.write(`${JSON.stringify({ id: parsed.id, ...response })}\n`);
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	return {
		socketPath,
		methods,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
			fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
		},
	};
}

export function createScriptedHerdrTracker(): ScriptedHerdrTracker {
	const openServers: ScriptedHerdr[] = [];
	return {
		start: async (respondToRequest) => {
			const herdr = await startScriptedHerdr(respondToRequest);
			openServers.push(herdr);
			return herdr;
		},
		closeAll: async () => {
			while (openServers.length > 0) await openServers.pop()?.close();
		},
	};
}

export function runnerOptionsFor(herdr: ScriptedHerdr): RunnerOptions {
	const selection = HerdrBackend.fromEnv({
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: herdr.socketPath,
		HERDR_PANE_ID: "parent-pane",
		HERDR_WORKSPACE_ID: "workspace-1",
	});
	if (!selection.ok) throw new Error(selection.message);
	return {
		agents: discoverUserAgents(),
		parentCwd: process.cwd(),
		includeProjectAgents: false,
		detectAutoBackend: () => selection,
	};
}

export function standardLaunchResponse(request: RpcRequest): RpcResponse | undefined {
	switch (request.method) {
		case "tab.list":
			return { result: { tabs: [{ tab_id: "subagent-tab", label: "subagents" }] } };
		case "pane.list":
			return { result: { panes: [{ pane_id: "target-pane", tab_id: "subagent-tab" }] } };
		case "pane.split":
			return { result: { type: "pane_info", pane: { pane_id: "launch-pane" } } };
		case "agent.list":
			return { result: { agents: [] } };
		default:
			return undefined;
	}
}

export async function waitForRpcCount(herdr: ScriptedHerdr, count: number): Promise<void> {
	for (let attempt = 0; attempt < 20 && herdr.methods.length < count; attempt++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	expect(herdr.methods.length).toBeGreaterThanOrEqual(count);
}

export async function advanceObservationPoll(
	herdr: ScriptedHerdr,
	expectedRpcCount: number,
): Promise<void> {
	await vi.advanceTimersByTimeAsync(800);
	await waitForRpcCount(herdr, expectedRpcCount);
}
