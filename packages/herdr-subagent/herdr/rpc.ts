import { createConnection } from "node:net";

/** The callable boundary between Herdr operations and its socket transport. */
export type HerdrRpcCall = (
	method: string,
	params: unknown,
	timeoutMs: number,
	signal?: AbortSignal,
) => Promise<unknown>;

/** The Herdr server returned an explicit JSON-RPC error response. */
export class HerdrRpcResponseError extends Error {
	constructor(message: string, readonly code?: string | number) {
		super(message);
		this.name = "HerdrRpcResponseError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Create a newline-delimited JSON-RPC call over one Unix-socket connection. */
export function createHerdrRpc(socketPath: string): HerdrRpcCall {
	return (method, params, timeoutMs, signal) => {
		if (signal?.aborted) return Promise.reject(new Error(`herdr rpc aborted (${method})`));

		const id = `pi-sub:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

		return new Promise((resolve, reject) => {
			let buffer = "";
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const socket = createConnection(socketPath);
			let onAbort: () => void = () => {};

			const settle = (complete: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				try {
					socket.destroy();
				} catch {
					/* ignore */
				}
				complete();
			};

			onAbort = () => settle(() => reject(new Error(`herdr rpc aborted (${method})`)));

			const onLine = (line: string) => {
				if (!line.trim()) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line) as unknown;
				} catch {
					return;
				}
				if (!isRecord(parsed) || parsed.id !== id) return;
				if (!Object.hasOwn(parsed, "result") && !Object.hasOwn(parsed, "error")) return;

				settle(() => {
					if (Object.hasOwn(parsed, "error")) {
						const responseError = parsed.error;
						if (typeof responseError === "string") {
							reject(new HerdrRpcResponseError(responseError));
							return;
						}
						const errorMessage = isRecord(responseError) && typeof responseError.message === "string"
							? responseError.message
							: JSON.stringify(responseError) ?? String(responseError);
						const errorCode = isRecord(responseError) &&
							(typeof responseError.code === "string" || typeof responseError.code === "number")
							? responseError.code
							: undefined;
						reject(new HerdrRpcResponseError(errorMessage, errorCode));
						return;
					}
					resolve(parsed.result);
				});
			};

			socket.on("connect", () => {
				socket.write(`${JSON.stringify({ id, method, params })}\n`);
			});

			socket.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) onLine(line);
			});

			socket.on("error", (error) => {
				settle(() => reject(new Error(`herdr socket error: ${error.message}`)));
			});

			const closeWithoutResponse = () => {
				if (buffer.trim()) onLine(buffer);
				settle(() => reject(new Error("herdr socket closed without response")));
			};
			socket.on("end", closeWithoutResponse);
			socket.on("close", closeWithoutResponse);

			timer = setTimeout(() => {
				settle(() => reject(new Error(`herdr rpc timeout after ${timeoutMs}ms (${method})`)));
			}, timeoutMs);
			timer.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	};
}
