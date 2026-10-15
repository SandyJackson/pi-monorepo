import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gh } from "./github.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(spawn).mockReset();
  // An empty inherited host is never a mismatch, so these tests do not depend on the developer's shell.
  vi.stubEnv("GH_HOST", "");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

it("gh keeps a supplied deadline and the forced host together", async () => {
  const child = runningChild();
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  const stopped = expect(
    gh({ cwd: ".", timeoutMs: 120_000 }, "github.example.com", "api", "user"),
  ).rejects.toMatchObject({ name: "CommandStoppedError", message: "Timed out running gh\n" });
  expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
    env: expect.objectContaining({ GH_HOST: "github.example.com" }),
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  await stopped;
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
});

it("gh rejects an inherited host that differs from the run origin before spawning", async () => {
  vi.stubEnv("GH_HOST", "other.example.com");
  await expect(gh(".", "github.example.com", "api", "user")).rejects.toThrow(
    "does not match this run's origin host",
  );
  expect(spawn).not.toHaveBeenCalled();
});
