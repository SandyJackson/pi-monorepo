import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest, fixture, readState, readWorkers, runDirFrom } from "./cli-fixture.ts";

cliTest(
  "reassesses a blocked review with a replacement check without resetting its budgets",
  async () => {
    const f = fixture("blocked-review");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first);
    const blocked = readState(runDir);
    expect(blocked.tickets[0].review?.outcome).toBe("blocked");
    f.env.FIXTURE_MODE = "pass";
    const check = "test -f feature.txt";
    const resumed = await f.run("resume", runDir, "--check", check);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.check).toBe(check);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].repairs).toBe(blocked.tickets[0].repairs);
    expect(finished.tickets[0].reviewTask).toBe(blocked.tickets[0].reviewTask);
    expect(finished.tickets[0].reviews).toContainEqual(blocked.tickets[0].review);
    expect(finished.sessions.slice(0, blocked.sessions.length)).toEqual(blocked.sessions);
    const reviews = readWorkers(f.root).filter((worker) => worker.name.includes("#11 review"));
    expect(reviews).toHaveLength(2);
    expect(reviews[1].session).toBe(reviews[0].session);
    expect(reviews[1].prompt).toContain(check);
  },
  30_000,
);

cliTest(
  "persists a failing replacement and rechecks publication rather than reusing the old gate",
  async () => {
    const f = fixture();
    const hook = join(f.repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first);
    const blocked = readState(runDir);
    expect(blocked.phase).toBe("publish");
    const resumed = await f.run("resume", runDir, "--check", "false");
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("Required checks failed for the publication artifact");
    const failed = readState(runDir);
    expect(failed.check).toBe("false");
    expect(failed.phase).toBe("final");
    expect(failed.prDescription).toBeUndefined();
    expect(failed.finalCheckLog).toBeUndefined();
    expect(failed.tickets).toEqual(blocked.tickets);
    expect(failed.sessions).toEqual(blocked.sessions);
    const retry = await f.run("resume", runDir);
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain("Required checks failed for the publication artifact");
    rmSync(hook);
    const recovered = await f.run("resume", runDir, "--check", "true");
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readState(runDir).status).toBe("done");
    expect(readFileSync(join(runDir, "pr.md"), "utf8")).toContain("Checks: `true`");
  },
  30_000,
);

cliTest(
  "does not change locked, completed, or invalidly requested run state",
  async () => {
    const f = fixture();
    const first = await f.start();
    expect(first.status, first.stderr).toBe(0);
    const runDir = runDirFrom(first);
    const statePath = join(runDir, "state.json");
    const original = readFileSync(statePath, "utf8");
    for (const check of ["", "   ", "false"]) {
      const result = await f.run("resume", runDir, "--check", check);
      expect(result.status).toBe(1);
      expect(readFileSync(statePath, "utf8")).toBe(original);
    }
    writeFileSync(join(runDir, "run.lock"), "12345\n");
    const locked = await f.run("resume", runDir, "--check", "false");
    expect(locked.status).toBe(1);
    expect(locked.stderr).toContain("Run is locked");
    expect(readFileSync(statePath, "utf8")).toBe(original);
    rmSync(join(runDir, "run.lock"));
  },
  30_000,
);
