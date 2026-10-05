import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { command } from "./process.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(spawn).mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function runningChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  return child;
}

it("terminates a timed-out command and reports its stderr without waiting for real time", async () => {
  const child = runningChild();
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  const stopped = expect(
    command("test-command", [], { cwd: ".", timeoutMs: 100 }),
  ).rejects.toMatchObject({
    name: "CommandStoppedError",
    message: "Timed out running test-command\nstill running",
  });
  child.stderr.write("still running");
  await vi.advanceTimersByTimeAsync(100);
  await stopped;
  expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGTERM");
  expect(vi.getTimerCount()).toBe(0);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});

it("escalates a stubborn timed-out command to SIGKILL using virtual time", async () => {
  const child = runningChild();
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return true;
  });
  const stopped = expect(
    command("test-command", [], { cwd: ".", timeoutMs: 100 }),
  ).rejects.toMatchObject({
    name: "CommandStoppedError",
    message: "Timed out running test-command\n",
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGTERM");
  await vi.advanceTimersByTimeAsync(2_000);
  await stopped;
  expect(kill).toHaveBeenNthCalledWith(2, -child.pid, "SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
});
