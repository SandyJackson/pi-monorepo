import * as fs from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createHerdrRpc,
	HerdrRpcResponseError,
} from "./rpc.js";

interface RpcRequest {
	id: string;
	method: string;
	params: unknown;
}

interface ScriptedSocket {
	socketPath: string;
	connections: number;
	close(): Promise<void>;
}

const servers: ScriptedSocket[] = [];

function isRpcRequest(value: unknown): value is RpcRequest {
	return typeof value === "object" && value !== null &&
		"id" in value && typeof value.id === "string" &&
		"method" in value && typeof value.method === "string" &&
		"params" in value;
}

async function startSocketServer(
	onRequest: (request: RpcRequest, socket: Socket) => void,
): Promise<ScriptedSocket> {
	const socketPath = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "herdr-rpc-test-")),
		"herdr.sock",
	);
	const sockets = new Set<Socket>();
	let connections = 0;
	const server: Server = createServer((socket) => {
		connections += 1;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const parsed: unknown = JSON.parse(line);
				if (isRpcRequest(parsed)) onRequest(parsed, socket);
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	const scriptedSocket: ScriptedSocket = {
		socketPath,
		get connections() {
			return connections;
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
			fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
		},
	};
	servers.push(scriptedSocket);
	return scriptedSocket;
}

function callAgentGet(socketPath: string, timeoutMs = 5_000, signal?: AbortSignal): Promise<unknown> {
	return createHerdrRpc(socketPath)("agent.get", { target: "pane-1" }, timeoutMs, signal);
}

afterEach(async () => {
	vi.useRealTimers();
	while (servers.length > 0) await servers.pop()?.close();
});

describe("Herdr RPC transport", () => {
	it("sends one newline-delimited request and resolves its matching response", async () => {
		let request: RpcRequest | undefined;
		const server = await startSocketServer((receivedRequest, socket) => {
			request = receivedRequest;
			socket.write(`${JSON.stringify({ id: receivedRequest.id, result: { ok: true } })}\n`);
		});

		const result = await createHerdrRpc(server.socketPath)(
			"agent.get",
			{ target: "pane-1" },
			5_000,
		);

		expect(result).toEqual({ ok: true });
		expect(request).toMatchObject({ method: "agent.get", params: { target: "pane-1" } });
		expect(request?.id).toEqual(expect.any(String));
	});

	it("uses a separate Unix-socket connection for each request", async () => {
		const server = await startSocketServer((request, socket) => {
			socket.write(`${JSON.stringify({ id: request.id, result: "ok" })}\n`);
		});
		const call = createHerdrRpc(server.socketPath);

		await call("agent.get", { target: "pane-1" }, 5_000);
		await call("agent.get", { target: "pane-2" }, 5_000);

		expect(server.connections).toBe(2);
	});

	it("preserves the code and message from a matching server error", async () => {
		const server = await startSocketServer((request, socket) => {
			socket.write(`${JSON.stringify({
				id: request.id,
				error: { code: "agent_name_taken", message: "name already used" },
			})}\n`);
		});

		const error = await callAgentGet(server.socketPath).then(
			() => null,
			(rejection: unknown) => rejection,
		);

		expect(error).toBeInstanceOf(HerdrRpcResponseError);
		if (error instanceof HerdrRpcResponseError) {
			expect(error.code).toBe("agent_name_taken");
			expect(error.message).toBe("name already used");
		}
	});

	it("treats an empty matching error field as an explicit response error", async () => {
		const server = await startSocketServer((request, socket) => {
			socket.write(`${JSON.stringify({ id: request.id, error: "" })}\n`);
		});

		const error = await callAgentGet(server.socketPath).then(
			() => null,
			(rejection: unknown) => rejection,
		);

		expect(error).toBeInstanceOf(HerdrRpcResponseError);
		if (error instanceof HerdrRpcResponseError) expect(error.message).toBe("");
	});

	it("ignores malformed and unrelated lines before processing a final unterminated response", async () => {
		const server = await startSocketServer((request, socket) => {
			socket.write("not json\n");
			socket.write(`${JSON.stringify({ id: "unrelated", result: "wrong" })}\n`);
			socket.write(`${JSON.stringify({ id: request.id })}\n`);
			socket.write(JSON.stringify({ id: request.id, result: "final" }));
			socket.end();
		});

		await expect(callAgentGet(server.socketPath)).resolves.toBe("final");
	});

	it("rejects when the socket closes without a matching response", async () => {
		const server = await startSocketServer((_request, socket) => socket.end());

		await expect(callAgentGet(server.socketPath)).rejects.toThrow(
			"herdr socket closed without response",
		);
	});

	it("rejects on a socket error", async () => {
		const missingSocketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-rpc-missing-"));
		const missingSocketPath = path.join(missingSocketDirectory, "missing.sock");

		try {
			await expect(callAgentGet(missingSocketPath)).rejects.toThrow("herdr socket error");
		} finally {
			fs.rmSync(missingSocketDirectory, { recursive: true, force: true });
		}
	});

	it("rejects and destroys the connection when the call times out", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let connectionClosed!: () => void;
		let requestReceived!: () => void;
		const closed = new Promise<void>((resolve) => {
			connectionClosed = resolve;
		});
		const received = new Promise<void>((resolve) => {
			requestReceived = resolve;
		});
		const server = await startSocketServer((_request, socket) => {
			requestReceived();
			socket.once("close", connectionClosed);
		});
		const pending = callAgentGet(server.socketPath, 1_000);
		const rejection = expect(pending).rejects.toThrow("herdr rpc timeout after 1000ms (agent.get)");

		await received;
		await vi.advanceTimersByTimeAsync(1_000);
		await rejection;
		await closed;
	});

	it("rejects and destroys the connection when cancelled", async () => {
		const controller = new AbortController();
		let requestReceived!: () => void;
		let connectionClosed!: () => void;
		const received = new Promise<void>((resolve) => {
			requestReceived = resolve;
		});
		const closed = new Promise<void>((resolve) => {
			connectionClosed = resolve;
		});
		const server = await startSocketServer((request, socket) => {
			requestReceived();
			socket.once("close", connectionClosed);
			setTimeout(() => {
				socket.write(`${JSON.stringify({ id: request.id, result: "too late" })}\n`);
			}, 10);
		});
		const pending = callAgentGet(server.socketPath, 5_000, controller.signal);
		let settlementCount = 0;
		void pending.then(
			() => settlementCount += 1,
			() => settlementCount += 1,
		);

		await received;
		controller.abort();

		await expect(pending).rejects.toThrow("herdr rpc aborted (agent.get)");
		await closed;
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(settlementCount).toBe(1);
	});
});
