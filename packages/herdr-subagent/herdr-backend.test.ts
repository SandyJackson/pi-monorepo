import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrBackend } from "./herdr-backend.js";

describe("HerdrBackend.waitForCompletion", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ignores startup idle until the child has reported active work", async () => {
		vi.useFakeTimers();

		const backend = new (HerdrBackend as any)({
			socketPath: "/tmp/herdr.sock",
			paneId: "w1:p1",
			workspaceId: "w1",
		});
		const rpcCall = vi.spyOn(backend, "rpcCall").mockResolvedValueOnce({ agent_status: "idle" })
			.mockResolvedValueOnce({ agent_status: "idle" })
			.mockResolvedValueOnce({ agent_status: "working" })
			.mockResolvedValueOnce({ agent_status: "done" })
			.mockResolvedValueOnce({ agent_status: "done" });

		const outcome = backend.waitForCompletion(
			{
				id: "w1:p2",
				displayTarget: "pane w1:p2",
				label: "test-child",
				cleanup: () => {},
			},
			{ timeoutMs: 10_000 },
		);
		let settled = false;
		void outcome.then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(1600);
		expect(settled).toBe(false);
		expect(rpcCall).toHaveBeenCalledTimes(3);

		await vi.advanceTimersByTimeAsync(1600);
		await expect(outcome).resolves.toEqual({ reason: "completed", answerText: null });
		expect(rpcCall).toHaveBeenCalledTimes(5);
	});
});
