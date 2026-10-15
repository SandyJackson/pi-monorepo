// Stall checkpoints, aborts, and runtime accounting.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  readState,
  readSummary,
  readWorkers,
  runDirFrom,
  WATCHDOG_SILENCE_MS,
  writeWatchdogSettings,
} from "./cli-fixture.ts";

cliTest(
  "checkpoints and aborts a stalled worker while persisting the stop explanation",
  async () => {
    const f = fixture("stall-review");
    const settingsPath = writeWatchdogSettings(f.root);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("blocked");
    const review = state.sessions.find((session: { name: string }) =>
      session.name.includes("review"),
    );
    expect(review.stopReason).toContain("checkpoint-grace");
    expect(review.consumedMs).toBeGreaterThanOrEqual(WATCHDOG_SILENCE_MS);
    // The specific stalled-step evidence is persisted, not just the abort reason.
    expect(review.checkpoint).toMatchObject({ reason: "silence" });
    expect(review.checkpoint.detail).toContain("no observable progress");
    expect(state.lastError).toContain("checkpoint-grace");
    expect(readSummary(runDir)).toContain("checkpoint-grace");
    // The checkpoint request was delivered before the abort.
    const reviewCommands = readWorkers(f.root).filter((entry) => entry.name.includes("review"));
    expect(reviewCommands.some((entry) => entry.prompt?.includes("Controller checkpoint"))).toBe(
      true,
    );
  },
  30_000,
);

cliTest(
  "makes no work commit for an incomplete watchdog checkpoint",
  async () => {
    const f = fixture("stall-implement");
    const settingsPath = writeWatchdogSettings(f.root);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("blocked");
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(state.tickets[0].commit).toBeUndefined();
    expect(f.git("-C", state.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("0");
  },
  30_000,
);

cliTest(
  "does not commit an interrupted editing phase's saved files on resume",
  async () => {
    const f = fixture("stall-after-write");
    const settingsPath = writeWatchdogSettings(f.root);
    const args = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    ];
    const first = await f.run(...args);
    expect(first.status, first.stderr).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const afterFirst = readState(runDir);
    // The interrupted worker's saved file is preserved but uncommitted.
    expect(existsSync(join(afterFirst.worktree, "feature.txt"))).toBe(true);
    expect(afterFirst.tickets[0].anchor).toBeUndefined();
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(1);
    const state = readState(runDir);
    // Resuming unchanged must not turn the leftover file into a work commit.
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(state.tickets[0].commit).toBeUndefined();
    expect(f.git("-C", state.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("0");
    // The uncommitted artifact was still reviewed as HEAD plus its content tree,
    // with the untracked file in the cumulative patch.
    expect(state.tickets[0].review).toMatchObject({ outcome: "pass", head: state.baseSha });
    expect(state.tickets[0].review.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(state.tickets[0].review.tree).not.toBe(
      f.git("-C", state.worktree, "rev-parse", `${state.baseSha}^{tree}`),
    );
    const patch = readFileSync(join(runDir, "review.patch"), "utf8");
    expect(patch).toContain("feature.txt");
    expect(patch).toContain("partial");
  },
  30_000,
);

cliTest(
  "reuses consumed watchdog runtime when resuming an interrupted review",
  async () => {
    const f = fixture("stall-review");
    const settingsPath = writeWatchdogSettings(f.root);
    const args = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    ];
    const first = await f.run(...args);
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const afterFirst = readState(runDir);
    const attemptOne = afterFirst.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 1"),
    );
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const afterResume = readState(runDir);
    const attemptTwo = afterResume.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 2"),
    );
    expect(attemptOne.consumedMs).toBeGreaterThanOrEqual(WATCHDOG_SILENCE_MS);
    expect(attemptTwo.consumedMs).toBeGreaterThan(attemptOne.consumedMs + 50);
    expect(attemptTwo.continuationUsed).toBe(false);
    // The recovery prompt replays the persisted checkpoint evidence so an
    // unconsumed steer is not the only record.
    const attemptTwoWorkers = readWorkers(f.root).filter((entry) =>
      entry.name.includes("review · attempt 2"),
    );
    expect(attemptTwoWorkers.some((entry) => entry.prompt.includes("Recovery context"))).toBe(true);
    expect(attemptTwoWorkers.some((entry) => entry.prompt.includes("no observable progress"))).toBe(
      true,
    );
  },
  30_000,
);

cliTest(
  "inherits recovery state when resume startup is interrupted before accounting",
  async () => {
    const f = fixture("stall-review");
    const settingsPath = writeWatchdogSettings(f.root);
    const args = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    ];
    const first = await f.run(...args);
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const statePath = join(runDir, "state.json");
    const afterFirst = JSON.parse(readFileSync(statePath, "utf8"));
    const attemptOne = afterFirst.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 1"),
    );
    expect(attemptOne.consumedMs).toBeGreaterThanOrEqual(WATCHDOG_SILENCE_MS);
    expect(attemptOne.checkpoint).toMatchObject({ reason: "silence" });
    // Interrupt the controller after it persists the new attempt but before the
    // worker can report any accounting. A directory at the log path makes the
    // worker fail to start without touching the restored state.
    const nextLog = join(runDir, "logs", `${afterFirst.sessions.length + 1}-review.log`);
    mkdirSync(nextLog, { recursive: true });
    const interrupted = await f.run("resume", runDir);
    expect(interrupted.status).toBe(1);
    const afterInterrupt = JSON.parse(readFileSync(statePath, "utf8"));
    const attemptTwo = afterInterrupt.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 2"),
    );
    // The interrupted attempt must inherit the allowance and evidence, not
    // reset them, because it is now the latest recovery source.
    expect(attemptTwo.consumedMs).toBe(attemptOne.consumedMs);
    expect(attemptTwo.continuationUsed).toBe(false);
    expect(attemptTwo.checkpoint).toMatchObject({ reason: "silence" });
    expect(attemptTwo.outcome).toBeUndefined();
    rmSync(nextLog, { recursive: true, force: true });
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(statePath, "utf8"));
    const attemptThree = finished.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 3"),
    );
    expect(attemptThree.consumedMs).toBeGreaterThanOrEqual(attemptTwo.consumedMs);
  },
  30_000,
);

cliTest(
  "reuses consumed runtime after an unsuccessful exit, not only a watchdog abort",
  async () => {
    const f = fixture("fail-review-after-delay");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const afterFirst = readState(runDir);
    const attemptOne = afterFirst.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 1"),
    );
    expect(attemptOne.consumedMs).toBeGreaterThanOrEqual(200);
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const afterResume = readState(runDir);
    const attemptTwo = afterResume.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 2"),
    );
    // The resumed review inherits the runtime already spent by the crashed one.
    expect(attemptTwo.consumedMs).toBeGreaterThan(attemptOne.consumedMs);
  },
  30_000,
);
