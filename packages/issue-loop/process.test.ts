import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { command, git } from "./process.ts";

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
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
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
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
  expect(kill).not.toHaveBeenCalledWith(-child.pid, "SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});

it("waits for descendant cleanup when a timed-out command leader closes first", async () => {
  const child = runningChild();
  let groupAlive = true;
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0 && !groupAlive)
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", 0, null));
    if (signal === "SIGKILL") groupAlive = false;
    return true;
  });
  let settled = false;
  const result = command("test-command", [], { cwd: ".", timeoutMs: 100 });
  result.catch(() => {
    settled = true;
  });
  const stopped = expect(result).rejects.toMatchObject({
    name: "CommandStoppedError",
    message: "Timed out running test-command\n",
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await stopped;
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  expect(groupAlive).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up surviving descendants even when the command leader exits successfully", async () => {
  const child = runningChild();
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  let settled = false;
  const result = command("test-command", [], { cwd: ".", timeoutMs: 100 });
  result.then(() => {
    settled = true;
  });
  child.stdout.write("completed output\n");
  child.emit("close", 0, null);
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(false);
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
  // The command deadline must not turn successful bounded cleanup into a timeout.
  await vi.advanceTimersByTimeAsync(1_900);
  await expect(result).resolves.toBe("completed output");
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});

it("escalates immediately on another interrupt while descendant cleanup is pending", async () => {
  const child = runningChild();
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const result = command("test-command", [], { cwd: ".", timeoutMs: 100 });
  const stopped = expect(result).rejects.toMatchObject({ name: "CommandStoppedError" });
  await vi.advanceTimersByTimeAsync(100);
  child.emit("close", 0, null);
  process.emit("SIGINT");
  await stopped;
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
});

it("settles when signalling an exited but unreaped command group reports EPERM", async () => {
  const child = runningChild();
  // macOS reports EPERM, not ESRCH, for a process group whose members have all
  // exited but not been reaped, e.g. when the deadline fires as the leader exits.
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", 0, null));
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
  });
  const stopped = expect(
    command("test-command", [], { cwd: ".", timeoutMs: 100 }),
  ).rejects.toMatchObject({
    name: "CommandStoppedError",
    message: "Timed out running test-command\n",
  });
  await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(2_000);
  await stopped;
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
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

it("git keeps a supplied deadline longer than the 60 second default", async () => {
  const child = runningChild();
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  const stopped = expect(git({ cwd: ".", timeoutMs: 120_000 }, "status")).rejects.toMatchObject({
    name: "CommandStoppedError",
    message: "Timed out running git\n",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  await stopped;
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
  expect(vi.getTimerCount()).toBe(0);
});

it("git passes a string directory as the working directory with the default deadline", async () => {
  const child = runningChild();
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return true;
  });
  const result = git("/repo", "rev-parse", "HEAD");
  child.stdout.write("abc\n");
  child.emit("close", 0, null);
  await expect(result).resolves.toBe("abc");
  expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ cwd: "/repo" });
});
