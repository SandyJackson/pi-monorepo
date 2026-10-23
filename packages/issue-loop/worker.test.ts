import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  assertOutcomeConsistent,
  DESCRIBE_OUTCOME_EXAMPLES,
  EDITING_OUTCOME_EXAMPLES,
  type PhaseOutcome,
  parsePhaseOutcome,
  REVIEW_OUTCOME_EXAMPLES,
  runWorker,
  type WorkerAccounting,
  type WorkerClock,
  type WorkerIntervention,
  type WorkerRecovery,
} from "./worker.ts";

const root = mkdtempSync(join(tmpdir(), "loop-worker-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const peerScript = join(root, "peer.mjs");
writeFileSync(
  peerScript,
  `import { writeFileSync } from "node:fs";
const scenario = process.argv[2];
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const response = (id, data) => JSON.stringify({ id, type: "response", command: "prompt", success: true, data }) + "\\n";
let buffer = "";
let noEarlyExit = false;
function handle(command) {
  if (scenario === "handled") {
    out({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
    return;
  }
  if (scenario === "reject") {
    out({ id: command.id, type: "response", command: "prompt", success: false, error: "no model configured" });
    return;
  }
  const accepted = response(command.id, { disposition: "started" });
  if (scenario === "framing") {
    process.stdout.write(accepted.slice(0, 12));
    setTimeout(() => {
      process.stdout.write(accepted.slice(12));
      process.stdout.write(
        JSON.stringify({ type: "agent_start" }) + "\\n" +
        JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }) + "\\n",
      );
      const end = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "AUTHORITATIVE" }] } }) + "\\r\\n";
      process.stdout.write(end.slice(0, 24));
      setTimeout(() => {
        process.stdout.write(end.slice(24));
        out({ type: "agent_end", messages: [], willRetry: false });
        out({ type: "agent_settled" });
      }, 15);
    }, 15);
    return;
  }
  if (scenario === "wait-settled") {
    process.stdout.write(accepted);
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FIRST" }] } });
    out({ type: "agent_end", messages: [], willRetry: true });
    setTimeout(() => {
      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "SECOND" }] } });
      out({ type: "agent_settled" });
    }, 30);
    return;
  }
  if (scenario === "ignore-mismatched") {
    process.stdout.write(accepted);
    out({ type: "response", command: "get_state", id: "other", success: false, error: "ignore me" });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } });
    out({ type: "agent_settled" });
    return;
  }
  if (scenario === "malformed") {
    process.stdout.write(accepted);
    process.stdout.write("this is not json\\n");
    return;
  }
  if (scenario === "exit-early") {
    process.stdout.write(accepted);
    process.exit(0);
  }
  if (scenario === "error-message" || scenario === "aborted-message") {
    process.stdout.write(accepted);
    out({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: '{"outcome":"complete","summary":"Done."}' }],
        stopReason: scenario === "aborted-message" ? "aborted" : "error",
        ...(scenario === "error-message" ? { errorMessage: "provider stream failed" } : {}),
      },
    });
    out({ type: "agent_settled" });
    return;
  }
  if (scenario === "noisy-stderr") {
    process.stdout.write(accepted);
    noEarlyExit = true;
    process.stderr.write("NOISY_HEAD_MARKER " + "x".repeat(256 * 1024) + " NOISY_TAIL_MARKER\\n");
    // Hold the failure until stderr reaches the kernel: the controller may
    // tear the peer down as soon as the failed settlement lands, and anything
    // still in the userland queue would be lost. Kernel-buffered bytes survive.
    const waitDrain = () => {
      if (process.stderr.writableLength > 0) setTimeout(waitDrain, 10);
      else {
        out({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: '{"outcome":"complete","summary":"Done."}' }],
            stopReason: "error",
            errorMessage: "provider stream failed",
          },
        });
        out({ type: "agent_settled" });
      }
    };
    waitDrain();
    return;
  }
  if (scenario === "settled-stubborn") {
    process.stdout.write(accepted);
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } });
    out({ type: "agent_settled" });
    writeFileSync(process.cwd() + "/settled.pid", String(process.pid));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(accepted);
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled" });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\\n"); index !== -1; index = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => { if (!noEarlyExit) process.exit(0); });
`,
);

async function processGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function run(scenario: string, timeoutMs = 5_000) {
  return runWorker({
    executable: process.execPath,
    args: [peerScript, scenario],
    cwd: root,
    prompt: "Do the thing.",
    log: join(root, `${scenario}.log`),
    timeoutMs,
  });
}

it("frames partial, coalesced, and CRLF JSONL records", async () => {
  await expect(run("framing")).resolves.toMatchObject({ text: "AUTHORITATIVE" });
});

it("ignores responses for other command ids and waits for the settled run", async () => {
  await expect(run("wait-settled")).resolves.toMatchObject({ text: "SECOND" });
  await expect(run("ignore-mismatched")).resolves.toMatchObject({ text: "OK" });
});

it("rejects a handled prompt that started no run", async () => {
  await expect(run("handled")).rejects.toThrow(/handled the prompt without starting a run/);
});

it("rejects a refused prompt response", async () => {
  await expect(run("reject")).rejects.toThrow(/rejected the prompt: no model configured/);
});

it("rejects a malformed protocol record", async () => {
  await expect(run("malformed")).rejects.toThrow(/malformed JSON/);
});

it("rejects a process that exits before the run settles", async () => {
  await expect(run("exit-early")).rejects.toThrow(/before the run settled/);
});

it("persists consumed runtime when a worker exits before settling", async () => {
  const accounting: WorkerAccounting[] = [];
  await expect(
    runWorker({
      executable: process.execPath,
      args: [peerScript, "exit-early"],
      cwd: root,
      prompt: "Do the thing.",
      log: join(root, "exit-early-accounting.log"),
      timeoutMs: 5_000,
      onAccounting: (value) => accounting.push(value),
    }),
  ).rejects.toThrow(/before the run settled/);
  expect(accounting.length).toBeGreaterThan(0);
  expect(typeof accounting.at(-1)?.consumedMs).toBe("number");
});

it("rejects a settled run whose final message failed, even with valid outcome JSON", async () => {
  await expect(run("error-message")).rejects.toThrow(
    /unsuccessful response \(error: provider stream failed\)/,
  );
  await expect(run("aborted-message")).rejects.toThrow(/unsuccessful response \(aborted\)/);
});

it("reports the tail of noisy worker stderr on failure", async () => {
  const error = await run("noisy-stderr").then(
    () => {
      throw new Error("expected the noisy run to fail");
    },
    (error: unknown) => error,
  );
  expect(String(error)).toContain("NOISY_TAIL_MARKER");
  expect(String(error)).not.toContain("NOISY_HEAD_MARKER");
});

it("completes process-group escalation before settling after an abort", async () => {
  const wd = startWatchdog("descendant");
  const promise = wd.start({
    watchdog: {
      silenceMs: 200,
      toolMs: 1_000_000,
      softCheckpointMs: 1_000_000,
      hardCeilingMs: 1_000_000,
      checkpointGraceMs: 100,
      abortGraceMs: 100,
      sigkillEscalationMs: 100,
    },
  });
  let settled = "pending";
  promise.then(
    () => {
      settled = "resolved";
    },
    () => {
      settled = "rejected";
    },
  );
  const pidFile = join(wd.dir, "descendant.pid");
  const readyFile = join(wd.dir, "desc-ready");
  let pid: number | undefined;
  try {
    await wd.accepted();
    const leaderPid = Number(readFileSync(join(wd.dir, "leader.pid"), "utf8"));
    for (let attempt = 0; attempt < 200 && !existsSync(readyFile); attempt++) await delay(10);
    expect(existsSync(readyFile)).toBe(true);
    pid = Number(readFileSync(pidFile, "utf8"));
    await wd.clock.advance(200);
    await wd.waitForCommand("steer");
    await wd.clock.advance(100);
    await wd.waitForCommand("abort");
    // Abort grace starts the SIGTERM; the leader exits but its descendant
    // ignores it, so the promise must wait for the SIGKILL escalation.
    await wd.clock.advance(100);
    await expect(processGone(leaderPid)).resolves.toBe(true);
    await flush();
    expect(settled).toBe("pending");
    await wd.clock.advance(100);
    await flush();
    expect(settled).toBe("rejected");
    await expect(promise).rejects.toThrow(/checkpoint-grace/);
    await expect(processGone(pid)).resolves.toBe(true);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
  }
});

it("terminates descendants when the leader exits before acknowledging the abort", async () => {
  const wd = startWatchdog("exit-on-abort");
  const promise = wd.start({
    watchdog: {
      silenceMs: 200,
      toolMs: 1_000_000,
      softCheckpointMs: 1_000_000,
      hardCeilingMs: 1_000_000,
      checkpointGraceMs: 100,
      abortGraceMs: 10_000,
      sigkillEscalationMs: 100,
    },
  });
  const pidFile = join(wd.dir, "descendant.pid");
  const readyFile = join(wd.dir, "desc-ready");
  let pid: number | undefined;
  try {
    await wd.accepted();
    const leaderPid = Number(readFileSync(join(wd.dir, "leader.pid"), "utf8"));
    for (let attempt = 0; attempt < 200 && !existsSync(readyFile); attempt++) await delay(10);
    expect(existsSync(readyFile)).toBe(true);
    pid = Number(readFileSync(pidFile, "utf8"));
    await wd.clock.advance(200);
    await wd.waitForCommand("steer");
    await wd.clock.advance(100);
    await wd.waitForCommand("abort");
    // The leader exits without acknowledging, long before the abort grace.
    // finish must still start the bounded group termination it would otherwise
    // have lost with the cleared abort timer.
    await expect(processGone(leaderPid)).resolves.toBe(true);
    await flush();
    await wd.clock.advance(100);
    await flush();
    await expect(promise).rejects.toThrow(/checkpoint-grace/);
    await expect(processGone(pid)).resolves.toBe(true);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
  }
});

it("bounds shutdown of a settled peer that ignores SIGTERM", async () => {
  const started = Date.now();
  await expect(
    runWorker({
      executable: process.execPath,
      args: [peerScript, "settled-stubborn"],
      cwd: root,
      prompt: "Do the thing.",
      log: join(root, "settled-stubborn.log"),
      timeoutMs: 5_000,
      settleGraceMs: 50,
      sigkillEscalationMs: 50,
    }),
  ).resolves.toMatchObject({ text: "DONE" });
  expect(Date.now() - started).toBeLessThan(2_000);
  const pid = Number(readFileSync(join(root, "settled.pid"), "utf8"));
  await expect(processGone(pid)).resolves.toBe(true);
});

describe("parsePhaseOutcome", () => {
  it("accepts a complete editing outcome", () => {
    expect(
      parsePhaseOutcome("editing", JSON.stringify({ outcome: "complete", summary: "Done." })),
    ).toEqual({ outcome: "complete", summary: "Done.", findings: [] });
  });

  it("accepts a passing review with structured findings", () => {
    const result = parsePhaseOutcome(
      "review",
      JSON.stringify({
        outcome: "pass",
        summary: "Looks good.",
        findings: [
          {
            axis: "design-maintainability",
            priority: "P3",
            location: "src/a.ts:1",
            description: "Rename this.",
          },
        ],
      }),
    );
    expect(result.findings).toEqual([
      {
        axis: "design-maintainability",
        priority: "P3",
        location: "src/a.ts:1",
        description: "Rename this.",
      },
    ]);
  });

  it("rejects editing outcomes that claim pass or carry findings", () => {
    expect(() =>
      parsePhaseOutcome("editing", JSON.stringify({ outcome: "pass", summary: "Done." })),
    ).toThrow(/outcome must be one of complete, incomplete, blocked/);
    expect(() =>
      parsePhaseOutcome(
        "editing",
        JSON.stringify({
          outcome: "complete",
          summary: "Done.",
          findings: [
            {
              axis: "correctness-requirements",
              priority: "P1",
              location: "x",
              description: "Missing.",
            },
          ],
        }),
      ),
    ).toThrow(/editing outcomes cannot carry findings/);
  });

  it("rejects a review outcome that claims complete", () => {
    expect(() =>
      parsePhaseOutcome("review", JSON.stringify({ outcome: "complete", summary: "Done." })),
    ).toThrow(/outcome must be one of pass, changes_requested, incomplete, blocked/);
  });

  it("rejects a pass with blocking findings and a changes_requested without them", () => {
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "pass",
          summary: "Fine.",
          findings: [
            {
              axis: "correctness-requirements",
              priority: "P1",
              location: "x",
              description: "Missing.",
            },
          ],
        }),
      ),
    ).toThrow(/pass cannot carry P0, P1 or P2 findings/);
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "changes_requested",
          summary: "Fix it.",
          findings: [
            {
              axis: "correctness-requirements",
              priority: "P3",
              location: "x",
              description: "Tidy.",
            },
          ],
        }),
      ),
    ).toThrow(/changes_requested must carry at least one P0, P1 or P2 finding/);
  });

  it("requires remainingWork for incomplete and blockers for blocked", () => {
    expect(() =>
      parsePhaseOutcome("editing", JSON.stringify({ outcome: "incomplete", summary: "Not done." })),
    ).toThrow(/incomplete outcomes must report remainingWork/);
    expect(
      parsePhaseOutcome(
        "editing",
        JSON.stringify({ outcome: "incomplete", summary: "Not done.", remainingWork: "Finish B." }),
      ),
    ).toMatchObject({ outcome: "incomplete", remainingWork: "Finish B." });
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({ outcome: "blocked", summary: "Stuck.", findings: [] }),
      ),
    ).toThrow(/blocked outcomes must report blockers/);
  });

  it("rejects a finding axis outside the advertised enum", () => {
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "pass",
          summary: "Fine.",
          findings: [{ axis: "spec", priority: "P3", location: "x", description: "y" }],
        }),
      ),
    ).toThrow(
      /finding axis must be one of correctness-requirements, design-maintainability, tests-verification, security-resilience/,
    );
  });

  it("rejects malformed findings and unknown keys", () => {
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "pass",
          summary: "Fine.",
          findings: [
            {
              axis: "correctness-requirements",
              priority: "P3",
              location: "x",
              description: "y",
              id: 1,
            },
          ],
        }),
      ),
    ).toThrow(/each finding must have exactly/);
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({ outcome: "pass", summary: "Fine.", findings: [], extra: true }),
      ),
    ).toThrow(/unexpected key "extra"/);
  });

  it("rejects free text without a JSON object", () => {
    expect(() => parsePhaseOutcome("editing", "PASS, probably.")).toThrow(
      /Invalid editing outcome/,
    );
  });

  it("accepts every editing example the prompt advertises", () => {
    for (const { outcome, example } of EDITING_OUTCOME_EXAMPLES)
      expect(parsePhaseOutcome("editing", JSON.stringify(example)).outcome).toBe(outcome);
  });

  it("accepts every describe example the prompt advertises", () => {
    for (const { outcome, example } of DESCRIBE_OUTCOME_EXAMPLES)
      expect(parsePhaseOutcome("describe", JSON.stringify(example)).outcome).toBe(outcome);
  });

  it("requires a body on a complete describe outcome and rejects it elsewhere", () => {
    expect(
      parsePhaseOutcome(
        "describe",
        JSON.stringify({ outcome: "complete", summary: "Done.", body: "## Summary" }),
      ),
    ).toEqual({ outcome: "complete", summary: "Done.", findings: [], body: "## Summary" });
    expect(() =>
      parsePhaseOutcome("describe", JSON.stringify({ outcome: "complete", summary: "Done." })),
    ).toThrow(/body must be a non-empty string/);
    expect(() =>
      parsePhaseOutcome(
        "editing",
        JSON.stringify({ outcome: "complete", summary: "Done.", body: "## Summary" }),
      ),
    ).toThrow(/only a complete describe outcome can carry a body/);
    expect(() =>
      parsePhaseOutcome("describe", JSON.stringify({ outcome: "pass", summary: "Done." })),
    ).toThrow(/outcome must be one of complete, incomplete, blocked during describe/);
  });

  it("accepts every review example the prompt advertises", () => {
    for (const { outcome, example } of REVIEW_OUTCOME_EXAMPLES)
      expect(parsePhaseOutcome("review", JSON.stringify(example)).outcome).toBe(outcome);
  });

  it("parses a fenced object and preserves backticks inside JSON strings", () => {
    expect(
      parsePhaseOutcome(
        "editing",
        '```json\n{"outcome":"complete","summary":"Use ``` fences ``` in docs."}\n```',
      ),
    ).toMatchObject({ outcome: "complete", summary: "Use ``` fences ``` in docs." });
    expect(
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "pass",
          summary: "Fine.",
          findings: [
            {
              axis: "design-maintainability",
              priority: "P3",
              location: "a.md",
              description: "Wrap this:\n```\n# heading\n````\nCloses #1",
            },
          ],
        }),
      ).findings[0].description,
    ).toContain("````");
  });
});

/** Virtual clock so watchdog deadlines are exercised without wall-clock waits. */
class FakeClock implements WorkerClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimer(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      let next: { id: number; at: number } | undefined;
      for (const [id, timer] of this.timers)
        if (timer.at <= target && (!next || timer.at < next.at)) next = { id, at: timer.at };
      if (!next) break;
      const timer = this.timers.get(next.id);
      this.timers.delete(next.id);
      this.current = Math.max(this.current, next.at);
      timer?.callback();
      await flush();
    }
    this.current = target;
    await flush();
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function flush(): Promise<void> {
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve));
}

async function waitForLog(log: string, marker: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(log) && readFileSync(log, "utf8").includes(marker)) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for log marker ${marker}`);
}

async function waitForCount(log: string, marker: string, count: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (text.split(marker).length - 1 >= count) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${count} copies of ${marker}`);
}

const watchdogPeer = join(root, "watchdog-peer.mjs");
writeFileSync(
  watchdogPeer,
  `import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.argv[2];
const scenario = process.argv[3] || "cooperative";
const commandsFile = dir + "/commands.jsonl";
const eventsFile = dir + "/events.jsonl";
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const record = (value) => appendFileSync(commandsFile, JSON.stringify(value) + "\\n");
writeFileSync(dir + "/leader.pid", String(process.pid));
let eventOffset = 0;
function drainEvents() {
  if (!existsSync(eventsFile)) return;
  const text = readFileSync(eventsFile, "utf8");
  const lines = text.slice(eventOffset).split("\\n");
  const complete = lines.slice(0, -1);
  eventOffset = text.length - lines[lines.length - 1].length;
  for (const line of complete) {
    if (!line.trim()) continue;
    out(JSON.parse(line));
  }
}
setInterval(drainEvents, 1).unref();
function handle(command) {
  record({ type: command.type, id: command.id, message: command.message });
  if (command.type === "prompt") {
    out({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    record({ type: "accepted", id: command.id });
    if (scenario === "uncooperative" || scenario === "queued") process.on("SIGTERM", () => {});
    if (scenario === "descendant" || scenario === "exit-on-abort") {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); require('fs').writeFileSync(" + JSON.stringify(dir + "/desc-ready") + ", ''); setInterval(()=>{},1000);"], { stdio: ["ignore", "ignore", "ignore"] });
      writeFileSync(dir + "/descendant.pid", String(child.pid));
      if (scenario === "descendant") process.on("SIGTERM", () => process.exit(0));
    }
    return;
  }
  if (command.type === "steer") {
    out({ id: command.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });
    return;
  }
  if (command.type === "clear_queue") {
    const steering = scenario === "queued" ? ["stale checkpoint"] : [];
    out({ id: command.id, type: "response", command: "clear_queue", success: true, data: { steering, followUp: [] } });
    return;
  }
  if (command.type === "abort") {
    if (scenario === "exit-on-abort") {
      process.exit(0);
      return;
    }
    if (scenario === "uncooperative" || scenario === "queued" || scenario === "descendant") return;
    out({ id: command.id, type: "response", command: "abort", success: true });
    setTimeout(() => process.exit(0), 5);
    return;
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\\n"); index !== -1; index = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  { mode: 0o755 },
);

const WATCHDOG_DEFAULTS = {
  silenceMs: 1_000_000,
  toolMs: 1_000_000,
  softCheckpointMs: 1_000_000,
  checkpointGraceMs: 1_000_000,
  hardCeilingMs: 1_000_000,
  abortGraceMs: 1_000,
  sigkillEscalationMs: 1_000,
};

interface WatchdogCommand {
  type: string;
  id?: string;
  message?: string;
}

function startWatchdog(scenario = "cooperative") {
  const dir = mkdtempSync(join(root, "wd-"));
  const clock = new FakeClock();
  const log = join(dir, "worker.log");
  const notices: WorkerIntervention[] = [];
  const commands = (): WatchdogCommand[] => {
    const file = join(dir, "commands.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WatchdogCommand);
  };
  const inject = (event: unknown) => {
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
  };
  const waitForCommand = async (type: string, count = 1) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (commands().filter((command) => command.type === type).length >= count) return;
      await delay(5);
    }
    throw new Error(`Timed out waiting for command ${type}`);
  };
  const accepted = async () => {
    await waitForCommand("accepted");
    await flush();
  };
  const waitForNotice = async (kind: WorkerIntervention["kind"], count = 1) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (notices.filter((notice) => notice.kind === kind).length >= count) return;
      await delay(5);
    }
    throw new Error(`Timed out waiting for ${kind} notice`);
  };
  const start = ({
    phase,
    watchdog,
    recovery,
    prompt,
    onAccounting,
    resolveOutcome,
    transientRetryLimit,
    transientBackoffMs,
  }: {
    phase?: "editing" | "review";
    watchdog?: Partial<typeof WATCHDOG_DEFAULTS>;
    recovery?: WorkerRecovery;
    prompt?: string;
    onAccounting?: (accounting: WorkerAccounting) => void;
    resolveOutcome?: (text: string) => PhaseOutcome;
    transientRetryLimit?: number;
    transientBackoffMs?: number[];
  } = {}) => {
    const promise = runWorker({
      executable: process.execPath,
      args: [watchdogPeer, dir, scenario],
      cwd: dir,
      prompt: prompt ?? "Do the thing.",
      log,
      clock,
      phase: phase ?? "editing",
      watchdog: { ...WATCHDOG_DEFAULTS, ...watchdog },
      recovery,
      resolveOutcome,
      transientRetryLimit,
      transientBackoffMs,
      onIntervention: (notice) => notices.push(notice),
      onAccounting,
    });
    // Tests assert rejection after driving virtual time; attach a handler now so
    // an interim rejection is not reported as an unhandled error.
    promise.catch(() => {});
    return promise;
  };
  return {
    dir,
    clock,
    log,
    notices,
    commands,
    inject,
    start,
    waitForCommand,
    waitForNotice,
    accepted,
  };
}

const startTool = (id: string, name = "bash") => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: name,
  args: {},
});
const toolUpdate = (id: string, text: string) => ({
  type: "tool_execution_update",
  toolCallId: id,
  toolName: "bash",
  partialResult: { content: [{ type: "text", text }] },
});
const outcomeMessage = (outcome: Record<string, unknown>) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(outcome) }] },
});

describe("supervised worker watchdog", () => {
  it("requests one structured checkpoint after the silence threshold", async () => {
    const wd = startWatchdog();
    const promise = wd.start({ watchdog: { silenceMs: 1_000 } });
    await wd.accepted();
    wd.inject(startTool("call-a"));
    await waitForLog(wd.log, "tool_execution_start");
    await wd.clock.advance(1_000);
    await wd.waitForCommand("steer");
    const steer = wd.commands().find((command) => command.type === "steer");
    expect(steer?.message).toContain("Phase: editing");
    expect(steer?.message).toContain("call-a");
    expect(steer?.message).toContain("Elapsed:");
    expect(steer?.message).toContain("Last progress:");
    expect(wd.notices.map((notice) => [notice.kind, notice.reason])).toEqual([
      ["checkpoint", "silence"],
    ]);
    expect(wd.notices[0].consumedMs).toBeGreaterThanOrEqual(1_000);
    // Incomplete checkpoint grants one same-session continuation that completes.
    wd.inject(
      outcomeMessage({ outcome: "incomplete", summary: "Still going.", remainingWork: "Finish." }),
    );
    wd.inject({ type: "agent_settled" });
    await wd.waitForCommand("prompt", 2);
    const continuation = wd.commands().filter((command) => command.type === "prompt")[1];
    expect(continuation.message).toContain("continuation");
    expect(continuation.message).toContain("Finish.");
    wd.inject(outcomeMessage({ outcome: "complete", summary: "Done." }));
    wd.inject({ type: "agent_settled" });
    await expect(promise).resolves.toMatchObject({
      text: expect.stringContaining('"complete"'),
      continuationUsed: true,
    });
    expect(wd.notices.map((notice) => notice.kind)).toEqual(["checkpoint", "continuation"]);
  });

  it("does not refresh progress on duplicate or empty tool snapshots", async () => {
    const wd = startWatchdog("uncooperative");
    const promise = wd.start({
      watchdog: {
        silenceMs: 1_000,
        checkpointGraceMs: 500,
        abortGraceMs: 100,
        sigkillEscalationMs: 100,
      },
    });
    await wd.accepted();
    wd.inject(startTool("a"));
    wd.inject(toolUpdate("a", "partial"));
    await waitForLog(wd.log, "partial");
    await wd.clock.advance(500);
    wd.inject(toolUpdate("a", "partial"));
    wd.inject(toolUpdate("a", ""));
    await waitForCount(wd.log, '"text":"partial"', 2);
    await waitForCount(wd.log, '"text":""', 1);
    await wd.clock.advance(501);
    await wd.waitForCommand("steer");
    expect(wd.notices[0]).toMatchObject({
      kind: "checkpoint",
      reason: "silence",
      detail: expect.stringContaining("no observable progress for 1000ms"),
    });
    await wd.clock.advance(500);
    await wd.clock.advance(100);
    await wd.clock.advance(100);
    await expect(promise).rejects.toThrow(/Worker stopped/);
  });

  it("caps a stalled tool independently of activity in another call", async () => {
    const wd = startWatchdog("uncooperative");
    const promise = wd.start({
      watchdog: {
        silenceMs: 1_000_000,
        toolMs: 2_000,
        checkpointGraceMs: 500,
        abortGraceMs: 100,
        sigkillEscalationMs: 100,
      },
    });
    await wd.accepted();
    wd.inject(startTool("slow"));
    await waitForLog(wd.log, '"slow"');
    await wd.clock.advance(500);
    wd.inject(startTool("busy"));
    wd.inject(toolUpdate("busy", "new output"));
    await waitForLog(wd.log, "new output");
    await wd.clock.advance(1_500);
    await wd.waitForCommand("steer");
    expect(wd.notices[0]).toMatchObject({
      kind: "checkpoint",
      reason: "tool-duration",
      detail: expect.stringContaining("slow"),
    });
    await wd.clock.advance(500);
    await wd.clock.advance(100);
    await wd.clock.advance(100);
    await expect(promise).rejects.toThrow(/Worker stopped/);
  });

  it("caps a noisy tool regardless of continuous output", async () => {
    const wd = startWatchdog("uncooperative");
    const promise = wd.start({
      watchdog: {
        silenceMs: 800,
        toolMs: 2_000,
        checkpointGraceMs: 500,
        abortGraceMs: 100,
        sigkillEscalationMs: 100,
      },
    });
    await wd.accepted();
    wd.inject(startTool("noisy"));
    await waitForLog(wd.log, '"noisy"');
    for (const [at, text] of [
      [500, "first"],
      [1_000, "second"],
      [1_500, "third"],
    ] as const) {
      await wd.clock.advance(at - wd.clock.now());
      wd.inject(toolUpdate("noisy", text));
      await waitForLog(wd.log, text);
    }
    await wd.clock.advance(500);
    await wd.waitForCommand("steer");
    expect(wd.notices[0]).toMatchObject({ kind: "checkpoint", reason: "tool-duration" });
    await wd.clock.advance(500);
    await wd.clock.advance(100);
    await wd.clock.advance(100);
    await expect(promise).rejects.toThrow(/Worker stopped/);
  });

  it("requests a soft checkpoint for a long productive phase", async () => {
    const wd = startWatchdog();
    const promise = wd.start({
      watchdog: { softCheckpointMs: 1_000, checkpointGraceMs: 1_000, abortGraceMs: 500 },
    });
    await wd.accepted();
    wd.inject(startTool("a"));
    await waitForLog(wd.log, "tool_execution_start");
    await wd.clock.advance(1_000);
    await wd.waitForCommand("steer");
    expect(wd.notices[0]).toMatchObject({ kind: "checkpoint", reason: "soft-checkpoint" });
    wd.inject(outcomeMessage({ outcome: "complete", summary: "Done." }));
    wd.inject({ type: "agent_settled" });
    await expect(promise).resolves.toMatchObject({ text: expect.stringContaining('"complete"') });
  });

  it("aborts after checkpoint grace and terminates the process group", async () => {
    const wd = startWatchdog("uncooperative");
    const promise = wd.start({
      watchdog: {
        silenceMs: 1_000,
        checkpointGraceMs: 500,
        abortGraceMs: 300,
        sigkillEscalationMs: 200,
      },
    });
    await wd.accepted();
    wd.inject(startTool("a"));
    await waitForLog(wd.log, "tool_execution_start");
    await wd.clock.advance(1_000);
    await wd.waitForCommand("steer");
    await wd.clock.advance(500);
    await wd.waitForCommand("abort");
    expect(wd.notices.map((notice) => notice.reason)).toEqual(["silence", "checkpoint-grace"]);
    await wd.clock.advance(300);
    await wd.clock.advance(200);
    await expect(promise).rejects.toThrow(/checkpoint-grace/);
  });

  it("settles when signalling an exited but unreaped worker group reports EPERM", async () => {
    // macOS reports EPERM, not ESRCH, for a process group whose members have all
    // exited but not been reaped. A worker that exits as soon as it acknowledges
    // the abort leaves exactly that window before the controller signals it.
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal !== 0)
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
      return realKill(pid, signal);
    });
    try {
      const wd = startWatchdog();
      const promise = wd.start({
        watchdog: {
          silenceMs: 1_000,
          checkpointGraceMs: 500,
          abortGraceMs: 300,
          sigkillEscalationMs: 200,
        },
      });
      await wd.accepted();
      wd.inject(startTool("a"));
      await waitForLog(wd.log, "tool_execution_start");
      await wd.clock.advance(1_000);
      await wd.waitForCommand("steer");
      await wd.clock.advance(500);
      await wd.waitForCommand("abort");
      await waitForLog(wd.log, '"command":"abort"');
      await wd.clock.advance(200);
      await expect(promise).rejects.toThrow(/checkpoint-grace/);
      expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });

  it("preserves the hard ceiling across resume using consumed runtime", async () => {
    const wd = startWatchdog();
    const promise = wd.start({
      watchdog: { hardCeilingMs: 1_000, checkpointGraceMs: 1_000, abortGraceMs: 500 },
      recovery: { consumedMs: 900 },
    });
    await wd.accepted();
    wd.inject(startTool("a"));
    await waitForLog(wd.log, "tool_execution_start");
    await wd.clock.advance(100);
    await wd.waitForCommand("abort");
    const abort = wd.notices.find((notice) => notice.kind === "abort");
    expect(abort).toMatchObject({ reason: "hard-ceiling" });
    expect(abort?.consumedMs).toBeGreaterThanOrEqual(1_000);
    await expect(promise).rejects.toThrow(/hard-ceiling/);
  });

  it("does not grant a second continuation after the persisted budget is used", async () => {
    const wd = startWatchdog("uncooperative");
    const promise = wd.start({
      watchdog: {
        silenceMs: 1_000,
        checkpointGraceMs: 500,
        abortGraceMs: 200,
        sigkillEscalationMs: 100,
      },
      recovery: { continuationUsed: true },
    });
    await wd.accepted();
    wd.inject(startTool("a"));
    await waitForLog(wd.log, "tool_execution_start");
    await wd.clock.advance(1_000);
    await wd.waitForCommand("abort");
    expect(wd.commands().some((command) => command.type === "steer")).toBe(false);
    expect(wd.notices.at(-1)).toMatchObject({
      kind: "abort",
      reason: "silence",
      continuationUsed: true,
    });
    await wd.clock.advance(200);
    await wd.clock.advance(100);
    await expect(promise).rejects.toThrow(/Worker stopped/);
  });

  it("accounts for queued messages and preserves the stop explanation", async () => {
    const wd = startWatchdog("queued");
    const promise = wd.start({
      watchdog: {
        silenceMs: 1_000,
        checkpointGraceMs: 500,
        abortGraceMs: 200,
        sigkillEscalationMs: 100,
      },
    });
    await wd.accepted();
    wd.inject(startTool("a"));
    await waitForLog(wd.log, "tool_execution_start");
    await wd.clock.advance(1_000);
    await wd.waitForCommand("steer");
    await wd.clock.advance(500);
    await wd.waitForCommand("abort");
    await flush();
    await delay(20);
    await wd.clock.advance(200);
    await wd.clock.advance(100);
    await expect(promise).rejects.toThrow(/Cleared queued steering: stale checkpoint/);
  });

  it("checkpoints a silent tool even while another call keeps producing output", async () => {
    const wd = startWatchdog("uncooperative");
    const promise = wd.start({
      watchdog: {
        silenceMs: 1_000,
        toolMs: 1_000_000,
        checkpointGraceMs: 500,
        abortGraceMs: 100,
        sigkillEscalationMs: 100,
      },
    });
    await wd.accepted();
    wd.inject(startTool("silent"));
    await waitForLog(wd.log, '"silent"');
    await wd.clock.advance(400);
    wd.inject(startTool("busy"));
    wd.inject(toolUpdate("busy", "alive-1"));
    await waitForLog(wd.log, "alive-1");
    for (const [at, text] of [
      [700, "alive-2"],
      [1_000, "alive-3"],
    ] as const) {
      await wd.clock.advance(at - wd.clock.now());
      wd.inject(toolUpdate("busy", text));
      await waitForLog(wd.log, text);
    }
    await wd.clock.advance(100);
    await wd.waitForCommand("steer");
    expect(wd.notices[0]).toMatchObject({
      kind: "checkpoint",
      reason: "silence",
      detail: expect.stringContaining("silent"),
    });
    await wd.clock.advance(500);
    await wd.clock.advance(100);
    await wd.clock.advance(100);
    await expect(promise).rejects.toThrow(/Worker stopped/);
  });

  it("grants the one continuation to a voluntary incomplete outcome", async () => {
    const wd = startWatchdog();
    const promise = wd.start();
    await wd.accepted();
    wd.inject(
      outcomeMessage({
        outcome: "incomplete",
        summary: "Not done.",
        remainingWork: "Finish the parser.",
      }),
    );
    wd.inject({ type: "agent_settled" });
    await wd.waitForCommand("prompt", 2);
    const continuation = wd.commands().filter((command) => command.type === "prompt")[1];
    expect(continuation.message).toContain("continuation");
    expect(continuation.message).toContain("Finish the parser.");
    expect(wd.notices.map((notice) => notice.kind)).toEqual(["continuation"]);
    wd.inject(outcomeMessage({ outcome: "complete", summary: "Done." }));
    wd.inject({ type: "agent_settled" });
    await expect(promise).resolves.toMatchObject({
      text: expect.stringContaining('"complete"'),
      continuationUsed: true,
    });
  });

  it("bounds a second voluntary incomplete after its continuation", async () => {
    const wd = startWatchdog("uncooperative");
    const promise = wd.start({
      watchdog: { checkpointGraceMs: 500, abortGraceMs: 100, sigkillEscalationMs: 100 },
    });
    await wd.accepted();
    wd.inject(
      outcomeMessage({ outcome: "incomplete", summary: "Not done.", remainingWork: "Finish." }),
    );
    wd.inject({ type: "agent_settled" });
    await wd.waitForCommand("prompt", 2);
    wd.inject(
      outcomeMessage({
        outcome: "incomplete",
        summary: "Still not done.",
        remainingWork: "Still finish.",
      }),
    );
    wd.inject({ type: "agent_settled" });
    await wd.waitForCommand("abort");
    expect(wd.notices.at(-1)).toMatchObject({ kind: "abort", reason: "second-incomplete" });
    await wd.clock.advance(100);
    await wd.clock.advance(100);
    await expect(promise).rejects.toThrow(/second-incomplete/);
  });

  it("flushes consumed runtime periodically for controller-crash durability", async () => {
    const wd = startWatchdog();
    const accounting: WorkerAccounting[] = [];
    const promise = wd.start({ onAccounting: (value) => accounting.push(value) });
    await wd.accepted();
    await wd.clock.advance(60_000);
    await flush();
    expect(accounting.length).toBeGreaterThanOrEqual(1);
    expect(accounting[0].consumedMs).toBeGreaterThanOrEqual(60_000);
    wd.inject(outcomeMessage({ outcome: "complete", summary: "Done." }));
    wd.inject({ type: "agent_settled" });
    await expect(promise).resolves.toMatchObject({ text: expect.stringContaining('"complete"') });
  });

  it("replays the interrupted attempt's stop explanation on recovery", async () => {
    const wd = startWatchdog();
    const promise = wd.start({
      recovery: {
        consumedMs: 100,
        continuationUsed: false,
        stopReason: "checkpoint-grace: checkpoint grace expired without a structured response",
        checkpoint: {
          reason: "silence",
          detail: "tool bash (call-a) produced no observable progress for 10000ms",
          elapsedMs: 10_000,
          consumedMs: 100,
        },
      },
    });
    await wd.accepted();
    const initial = wd
      .commands()
      .find((command) => command.type === "prompt" && command.id === "prompt-1");
    expect(initial?.message).toContain("Recovery context");
    expect(initial?.message).toContain("checkpoint-grace");
    expect(initial?.message).toContain("no observable progress for 10000ms");
    wd.inject(outcomeMessage({ outcome: "complete", summary: "Done." }));
    wd.inject({ type: "agent_settled" });
    await expect(promise).resolves.toMatchObject({ text: expect.stringContaining('"complete"') });
  });

  const autoRetryStarted = {
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 10,
    errorMessage: "529 overloaded",
  };
  const autoRetryExhausted = {
    type: "auto_retry_end",
    success: false,
    attempt: 3,
    finalError: "529 overloaded",
  };
  const failedTurn = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "provider failed" }],
      stopReason: "error",
      errorMessage: "529 overloaded",
    },
  };
  const injectFailedTurn = (wd: ReturnType<typeof startWatchdog>) => {
    // Pi emits the failing assistant message before its native retry ends.
    wd.inject(failedTurn);
    wd.inject(autoRetryStarted);
    wd.inject(autoRetryExhausted);
    wd.inject({ type: "agent_settled" });
  };

  it("does not charge Pi's native retries to the controller retry budget", async () => {
    const wd = startWatchdog();
    const promise = wd.start({ transientRetryLimit: 2, transientBackoffMs: [100, 100] });
    await wd.accepted();
    wd.inject(autoRetryStarted);
    wd.inject({ type: "auto_retry_end", success: true, attempt: 2 });
    wd.inject(outcomeMessage({ outcome: "complete", summary: "Done." }));
    wd.inject({ type: "agent_settled" });
    await expect(promise).resolves.toMatchObject({ transientRetries: 0, corrections: 0 });
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(1);
  });

  it("retries a transient failure after the configured backoff", async () => {
    const wd = startWatchdog();
    const promise = wd.start({ transientRetryLimit: 2, transientBackoffMs: [100, 200] });
    await wd.accepted();
    injectFailedTurn(wd);
    await wd.waitForNotice("retry");
    // The retry waits out its backoff; the recorded failure reason is replayed.
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(1);
    await wd.clock.advance(100);
    await wd.waitForCommand("prompt", 2);
    const retry = wd.commands().filter((command) => command.type === "prompt")[1];
    expect(retry.message).toContain("transient");
    expect(retry.message).toContain("529 overloaded");
    expect(retry.message).toContain("blindly");
    wd.inject(outcomeMessage({ outcome: "complete", summary: "Done." }));
    wd.inject({ type: "agent_settled" });
    await expect(promise).resolves.toMatchObject({ transientRetries: 1, corrections: 0 });
    expect(wd.notices.filter((notice) => notice.kind === "retry")).toHaveLength(1);
  });

  it("bounds transient controller retries and keeps their count durable", async () => {
    const wd = startWatchdog();
    const accounting: WorkerAccounting[] = [];
    const promise = wd.start({
      transientRetryLimit: 2,
      transientBackoffMs: [50, 75],
      onAccounting: (value) => accounting.push(value),
    });
    await wd.accepted();
    injectFailedTurn(wd);
    for (const [index, backoff] of [50, 75].entries()) {
      await wd.waitForNotice("retry", index + 1);
      await wd.clock.advance(backoff);
      await wd.waitForCommand("prompt", index + 2);
      injectFailedTurn(wd);
    }
    await expect(promise).rejects.toThrow(/transient retries were exhausted/);
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(3);
    expect(wd.notices.at(-1)?.transientRetries).toBe(2);
    // Backoff time counts against the phase allowance, not as free recovery time.
    expect(accounting.at(-1)?.consumedMs).toBeGreaterThanOrEqual(125);
  });

  it("does not retry an unclassified failure without Pi's transient signal", async () => {
    const wd = startWatchdog();
    const promise = wd.start({ transientRetryLimit: 2, transientBackoffMs: [100, 100] });
    await wd.accepted();
    wd.inject(failedTurn);
    wd.inject({ type: "agent_settled" });
    await expect(promise).rejects.toThrow(/unsuccessful response/);
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(1);
    expect(wd.notices.at(-1)?.transientRetries ?? 0).toBe(0);
  });

  it("does not retry a cancelled native retry", async () => {
    const wd = startWatchdog();
    const promise = wd.start({ transientRetryLimit: 2, transientBackoffMs: [100, 100] });
    await wd.accepted();
    wd.inject(failedTurn);
    wd.inject(autoRetryStarted);
    wd.inject({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "Retry cancelled",
    });
    wd.inject({ type: "agent_settled" });
    // The finalError is preserved; the retryable terminal text is not retried.
    await expect(promise).rejects.toThrow(/unsuccessful response \(error: Retry cancelled\)/);
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(1);
    expect(wd.notices.at(-1)?.transientRetries ?? 0).toBe(0);
  });

  it("does not retry a non-retryable failure after an earlier retry", async () => {
    const wd = startWatchdog();
    const promise = wd.start({ transientRetryLimit: 2, transientBackoffMs: [100, 100] });
    await wd.accepted();
    wd.inject({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "provider failed" }],
        stopReason: "error",
        errorMessage: "401 invalid api key",
      },
    });
    wd.inject(autoRetryStarted);
    wd.inject({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "401 invalid api key",
    });
    wd.inject({ type: "agent_settled" });
    await expect(promise).rejects.toThrow(/401 invalid api key/);
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(1);
    expect(wd.notices.at(-1)?.transientRetries ?? 0).toBe(0);
  });

  it("does not retry authorization failure from a turn queued after exhausted transient retries", async () => {
    const wd = startWatchdog();
    const promise = wd.start({ transientRetryLimit: 2, transientBackoffMs: [100, 100] });
    await wd.accepted();
    // Pi exhausts its own native retries on the overloaded provider...
    wd.inject(failedTurn);
    wd.inject(autoRetryStarted);
    wd.inject(autoRetryExhausted);
    // ...then processes queued checkpoint steering in a second turn that fails
    // with a non-retryable authentication error and emits no retry-end event.
    wd.inject({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "provider failed" }],
        stopReason: "error",
        errorMessage: "401 invalid api key",
      },
    });
    wd.inject({ type: "agent_settled" });
    // The stale overload evidence must not spend a controller retry here; the
    // worker must stop and report the authorization failure instead.
    const reported = () =>
      wd.notices.some((notice) => notice.kind === "retry" || notice.kind === "abort");
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !reported()) await delay(5);
    expect(wd.notices.some((notice) => notice.kind === "retry")).toBe(false);
    await expect(promise).rejects.toThrow(/401 invalid api key/);
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(1);
    expect(wd.notices.at(-1)?.transientRetries ?? 0).toBe(0);
  });

  it("cancels a pending retry when the hard ceiling expires during backoff", async () => {
    const wd = startWatchdog("uncooperative");
    const promise = wd.start({
      transientRetryLimit: 2,
      transientBackoffMs: [500, 500],
      watchdog: { hardCeilingMs: 200, abortGraceMs: 200, sigkillEscalationMs: 100 },
    });
    await wd.accepted();
    injectFailedTurn(wd);
    await wd.waitForNotice("retry");
    await wd.clock.advance(200);
    await wd.waitForCommand("abort");
    // The backoff expires during the unresponsive abort grace; no turn may be
    // dispatched after cancellation.
    await wd.clock.advance(200);
    await wd.clock.advance(100);
    await expect(promise).rejects.toThrow(/hard-ceiling/);
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(1);
  });

  it("corrects one malformed phase response in the same session", async () => {
    const wd = startWatchdog();
    const validated: string[] = [];
    const promise = wd.start({
      resolveOutcome: (text) => {
        validated.push(text);
        if (text !== '{"outcome":"complete","summary":"Done."}')
          throw new Error("not a valid outcome");
        return parsePhaseOutcome("editing", text);
      },
    });
    await wd.accepted();
    wd.inject({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "PASS, probably." }] },
    });
    wd.inject({ type: "agent_settled" });
    await wd.waitForCommand("prompt", 2);
    const correction = wd.commands().filter((command) => command.type === "prompt")[1];
    expect(correction.message).toContain("could not accept");
    expect(correction.message).toContain("not a valid outcome");
    wd.inject(outcomeMessage({ outcome: "complete", summary: "Done." }));
    wd.inject({ type: "agent_settled" });
    await expect(promise).resolves.toMatchObject({
      outcome: { outcome: "complete" },
      corrections: 1,
      transientRetries: 0,
    });
    expect(validated).toHaveLength(2);
  });

  it("stops after one correction when the response stays invalid", async () => {
    const wd = startWatchdog();
    const promise = wd.start({
      resolveOutcome: () => {
        throw new Error("still not a valid outcome");
      },
    });
    await wd.accepted();
    wd.inject({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "bad" }] },
    });
    wd.inject({ type: "agent_settled" });
    await wd.waitForCommand("prompt", 2);
    wd.inject({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "still bad" }] },
    });
    wd.inject({ type: "agent_settled" });
    await expect(promise).rejects.toThrow(/stayed invalid after one correction/);
    expect(wd.commands().filter((command) => command.type === "prompt")).toHaveLength(2);
    expect(wd.notices.at(-1)?.corrections).toBe(1);
  });
});

describe("assertOutcomeConsistent", () => {
  it("rejects a passing review when required checks failed", () => {
    const pass = parsePhaseOutcome(
      "review",
      JSON.stringify({ outcome: "pass", summary: "Fine.", findings: [] }),
    );
    expect(() => assertOutcomeConsistent("review", pass, { checksPassed: false })).toThrow(
      /required checks failed/,
    );
    expect(() => assertOutcomeConsistent("review", pass, { checksPassed: true })).not.toThrow();
  });
});
