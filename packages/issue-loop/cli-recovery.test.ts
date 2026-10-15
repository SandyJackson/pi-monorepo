// Transient recovery and response correction.
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  readState,
  readWorkers,
  runDirFrom,
  writeWatchdogSettings,
} from "./cli-fixture.ts";

cliTest(
  "starts a fresh review task after a repair instead of reusing an obsolete interrupted review",
  async () => {
    const f = fixture("stall-once");
    const settingsPath = writeWatchdogSettings(f.root);
    const first = await f.run(
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
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const state = readState(runDir);
    const reviews = state.sessions.filter((session: { name: string }) =>
      session.name.includes("#11 review"),
    );
    expect(reviews).toHaveLength(3);
    const [interrupted, repaired, fresh] = reviews;
    expect(interrupted.outcome).toBeUndefined();
    expect(repaired.outcome).toBe("changes_requested");
    expect(fresh.outcome).toBe("pass");
    // A completed review ends the phase task; the next review must not inherit
    // the obsolete interrupted attempt's consumed allowance.
    expect(fresh.consumedMs).toBeLessThan(interrupted.consumedMs);
  },
  30_000,
);

cliTest(
  "recovers a transient execution failure within the controller budget",
  async () => {
    const f = fixture("recover-transient");
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
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
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("done");
    const implement = state.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement"),
    );
    expect(implement.transientRetries).toBe(1);
    expect(implement.outcome).toBe("complete");
    // Recovery does not consume a child code-repair round.
    expect(state.tickets[0].repairs).toBe(0);
    // The retry prompt replayed the failure and warned against blind repetition.
    const prompts = readWorkers(f.root)
      .filter((worker) => worker.name.includes("#11 implement"))
      .map((worker) => worker.prompt);
    expect(
      prompts.some((prompt) => prompt.includes("transient") && prompt.includes("blindly")),
    ).toBe(true);
  },
  30_000,
);

cliTest(
  "bounds transient recovery and keeps the exhausted count across resume",
  async () => {
    const f = fixture("recover-exhausted");
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
    const args = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
      "--settings",
      settingsPath,
    ];
    const first = await f.run(...args);
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.status).toBe("blocked");
    expect(blocked.lastError).toContain("transient retries were exhausted");
    const attemptOne = blocked.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement"),
    );
    expect(attemptOne.transientRetries).toBe(2);
    // Execution recovery is separate from a code repair.
    expect(blocked.tickets[0].repairs).toBe(0);
    // Resume does not replenish the budget: the next transient failure stops
    // immediately without another retry prompt.
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const afterResume = readState(runDir);
    const attemptTwo = afterResume.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement · attempt 2"),
    );
    expect(attemptTwo.transientRetries).toBe(2);
    // Repeated infrastructure-failure resumes never spend the repair budget.
    expect(afterResume.tickets[0].repairs).toBe(0);
    // Resume does not replenish the budget, so the new attempt sends no retry.
    const attemptTwoPrompts = readWorkers(f.root).filter((worker) =>
      worker.name.includes("#11 implement · attempt 2"),
    );
    expect(
      attemptTwoPrompts.some(
        (worker) =>
          worker.prompt?.includes("Recovery context") && worker.prompt?.includes("transient"),
      ),
    ).toBe(true);
    const retryPrompts = attemptTwoPrompts.filter((worker) =>
      worker.prompt?.includes("exhausted its native provider retries"),
    );
    expect(retryPrompts).toHaveLength(0);
    // Once the environment is fixed, a later resume completes the run.
    f.env.FIXTURE_MODE = "pass";
    const finished = await f.run("resume", runDir);
    expect(finished.status, finished.stderr).toBe(0);
    const afterFinish = readState(runDir);
    expect(afterFinish.status).toBe("done");
    expect(afterFinish.tickets[0].repairs).toBe(0);
  },
  60_000,
);

cliTest(
  "corrects one malformed response instead of blocking the run",
  async () => {
    const f = fixture("recover-correction");
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
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
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("done");
    const implement = state.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement"),
    );
    expect(implement.corrections).toBe(1);
    expect(implement.outcome).toBe("complete");
    // The correction attempt does not consume a child code-repair round.
    expect(state.tickets[0].repairs).toBe(0);
    const prompts = readWorkers(f.root).filter((worker) => worker.name.includes("#11 implement"));
    expect(prompts.some((worker) => worker.prompt.includes("could not accept"))).toBe(true);
  },
  30_000,
);

cliTest(
  "does not spend a transient retry on an unclassified execution failure",
  async () => {
    const f = fixture("fail");
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
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
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].transientRetries ?? 0).toBe(0);
    expect(state.lastError).toContain("Provider unavailable");
  },
  30_000,
);
