import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  readState,
  readSummary,
  readWorkers,
  runDirFrom,
} from "./cli-fixture.ts";

const instructions =
  "The operator approved the production requirement change. Do not reject it as out of scope.";

cliTest(
  "reassesses a blocked verdict and includes operator corrections in every subsequent worker role",
  async () => {
    const f = fixture("blocked-review");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first);
    const blocked = readState(runDir);
    const workerCount = readWorkers(f.root).length;
    const file = join(f.root, "instructions.md");
    writeFileSync(file, instructions);
    f.env.FIXTURE_MODE = "fixup";
    const resumed = await f.run("resume", runDir, "--instructions-file", file);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.operatorInstructions).toBe(instructions);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].reviews).toContainEqual(blocked.tickets[0].review);
    expect(finished.sessions.slice(0, blocked.sessions.length)).toEqual(blocked.sessions);
    const later = readWorkers(f.root).slice(workerCount);
    for (const role of ["implement", "review", "repair", "audit", "describe"]) {
      expect(later.some((worker) => worker.name.includes(` ${role} `))).toBe(true);
    }
    expect(later.every((worker) => worker.prompt.includes(instructions))).toBe(true);
    expect(
      later.every((worker) =>
        worker.prompt.includes("Operator instructions (user-injected; persistent)"),
      ),
    ).toBe(true);
    expect(
      later.every((worker) =>
        worker.prompt.includes("take precedence over conflicting issue bodies"),
      ),
    ).toBe(true);
    expect(
      later.every((worker) => worker.prompt.includes("do not override system instructions")),
    ).toBe(true);
    const firstReview = later.find((worker) => worker.name.includes("#11 review"))!;
    expect(firstReview.session).toBe(blocked.tickets[0].reviewConversation);
    expect(readSummary(runDir)).toContain(instructions);
  },
  30_000,
);

cliTest(
  "snapshots instructions across resume without the original file and invalidates a cached description",
  async () => {
    const f = fixture();
    const hook = join(f.repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first);
    const before = readState(runDir);
    expect(before.prDescription).toBeDefined();
    rmSync(hook);
    const file = join(f.root, "instructions.md");
    writeFileSync(file, instructions);
    f.env.FIXTURE_MODE = "describe-blocked";
    const resumed = await f.run("resume", runDir, "--instructions-file", file, "--check", "true");
    expect(resumed.status).toBe(1);
    const blocked = readState(runDir);
    expect(blocked.phase).toBe("describe");
    expect(blocked.prDescription).toBeUndefined();
    expect(blocked.check).toBe("true");
    expect(blocked.tickets).toEqual(before.tickets);
    expect(blocked.operatorInstructions).toBe(instructions);
    rmSync(file);
    f.env.FIXTURE_MODE = "pass";
    const recovered = await f.run("resume", runDir);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readState(runDir).operatorInstructions).toBe(instructions);
    expect(readWorkers(f.root).at(-1)?.prompt).toContain(instructions);
  },
  30_000,
);

cliTest(
  "refuses missing or empty instruction files and overrides on locked or completed runs without changing state",
  async () => {
    const f = fixture("blocked-review");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first);
    const path = join(runDir, "state.json");
    const original = readFileSync(path, "utf8");
    const file = join(f.root, "instructions.md");
    const missing = await f.run("resume", runDir, "--instructions-file", file);
    expect(missing.status).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    writeFileSync(file, "  \n");
    const empty = await f.run("resume", runDir, "--instructions-file", file);
    expect(empty.status).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    writeFileSync(file, instructions);
    writeFileSync(join(runDir, "run.lock"), "12345\n");
    const locked = await f.run("resume", runDir, "--instructions-file", file);
    expect(locked.status).toBe(1);
    expect(locked.stderr).toContain("Run is locked");
    expect(readFileSync(path, "utf8")).toBe(original);
    rmSync(join(runDir, "run.lock"));
    f.env.FIXTURE_MODE = "pass";
    const done = await f.run("resume", runDir, "--instructions-file", file);
    expect(done.status, done.stderr).toBe(0);
    const completed = readFileSync(path, "utf8");
    const rejected = await f.run("resume", runDir, "--instructions-file", file);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("completed run");
    expect(readFileSync(path, "utf8")).toBe(completed);
  },
  30_000,
);
