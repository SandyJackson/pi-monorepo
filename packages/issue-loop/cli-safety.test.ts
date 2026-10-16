// Origin, ancestry, and artifact-safety guards.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { cli, cliTest, fixture, readState, readSummary, runDirFrom } from "./cli-fixture.ts";

cliTest(
  "preserves manual edits after a publication failure until the operator commits them",
  async () => {
    const f = fixture("publish-fail");
    const first = await f.start();
    const runDir = runDirFrom(first.stdout);
    const state = readState(runDir);
    writeFileSync(join(state.worktree, "feature.txt"), "Manual integration fix\n");
    // An uncommitted change is not a safe publication artifact: the gate blocks
    // with the work preserved instead of committing or reviewing it as parent work.
    const blocked = await f.run("resume", runDir);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("Uncommitted changes before publication");
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toBe(
      "Manual integration fix\n",
    );
    // Once the operator commits it, resume publishes the same artifact.
    f.git("-C", state.worktree, "add", "-A");
    f.git("-C", state.worktree, "commit", "-m", "Manual integration fix");
    const manual = f.git("-C", state.worktree, "rev-parse", "HEAD");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.head).toBe(manual);
    // The manual commit changed the publication HEAD, so it is described afresh.
    expect(finished.prDescription?.head).toBe(manual);
    expect(
      finished.sessions.filter((session: { name: string }) =>
        session.name.includes("parent describe"),
      ),
    ).toHaveLength(2);
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toBe(
      "Manual integration fix\n",
    );
  },
  30_000,
);

cliTest(
  "does not replenish an exhausted repair budget on resume",
  async () => {
    const f = fixture("reject");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const before = readState(runDir);
    const implementations = (state: typeof before) =>
      state.sessions.filter(
        (session: { name: string }) =>
          session.name.includes("implement") || session.name.includes("repair"),
      ).length;
    expect((await f.run("resume", runDir)).status).toBe(1);
    const after = readState(runDir);
    expect(implementations(after)).toBe(implementations(before));
    // A human fix can still be verified after the automatic repair budget is gone.
    f.env.FIXTURE_MODE = "pass";
    writeFileSync(join(before.worktree, "feature.txt"), "Manual fix\n");
    expect((await f.run("resume", runDir)).status).toBe(0);
  },
  30_000,
);

cliTest(
  "binds GitHub operations to origin instead of an inherited GH_REPO",
  async () => {
    const f = fixture();
    Object.assign(f.env, { GH_REPO: "wrong/repository" });
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    expect(readState(runDir).githubRepo).toBe("test/project");
  },
  30_000,
);

cliTest(
  "refuses to resume after origin is changed",
  async () => {
    const f = fixture("fail");
    const first = await f.start();
    const runDir = runDirFrom(first.stdout);
    f.git("remote", "set-url", "origin", "https://github.com/wrong/repository.git");
    const result = await f.run("resume", runDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("origin");
    const state = readState(runDir);
    expect(state.sessions).toHaveLength(1);
  },
  30_000,
);

cliTest(
  "reports a forbidden HEAD change even when the worker exits unsuccessfully",
  async () => {
    const f = fixture("commit-fail");
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HEAD changed outside the controller");
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.tickets[0].status).toBe("blocked");
  },
  30_000,
);

cliTest(
  "handles repeated interrupts without leaving a detached worker running",
  async () => {
    const f = fixture("stubborn");
    const child = spawn(
      process.execPath,
      [cli, "start", "--repo", f.repo, "--issue", "10", "--check", "true"],
      { env: f.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.resume();
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    let workerPid: number | undefined;
    try {
      const marker = join(f.root, "stubborn.pid");
      for (let i = 0; i < 200 && !existsSync(marker); i++) await delay(50);
      expect(existsSync(marker)).toBe(true);
      workerPid = Number(readFileSync(marker, "utf8"));
      child.kill("SIGINT");
      await delay(100);
      child.kill("SIGINT");
      await Promise.race([
        closed,
        delay(5000).then(() => {
          throw new Error("Controller did not stop");
        }),
      ]);
      const runDir = runDirFrom(output);
      const state = readState(runDir);
      expect(state.status).toBe("blocked");
      expect(existsSync(join(runDir, "run.lock"))).toBe(false);
      expect(() => process.kill(workerPid!, 0)).toThrow();
    } finally {
      child.kill("SIGKILL");
      if (workerPid) {
        try {
          process.kill(-workerPid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await closed;
    }
  },
  30_000,
);

cliTest(
  "rejects origin with multiple push destinations",
  async () => {
    const f = fixture();
    const origin = f.git("remote", "get-url", "origin");
    f.git("config", "--add", "remote.origin.pushurl", origin);
    f.git("config", "--add", "remote.origin.pushurl", join(f.root, "unintended.git"));
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exactly one");
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
  },
  30_000,
);

cliTest(
  "checks worktree-local remote settings before publication",
  async () => {
    const f = fixture("publish-fail");
    const first = await f.start();
    const runDir = runDirFrom(first.stdout);
    const state = readState(runDir);
    f.git("config", "extensions.worktreeConfig", "true");
    f.git(
      "-C",
      state.worktree,
      "config",
      "--worktree",
      "remote.origin.pushurl",
      join(f.root, "unintended.git"),
    );
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("origin must have exactly one");
  },
  30_000,
);

cliTest(
  "omits issue comments from saved requirements and every worker prompt",
  async () => {
    const f = fixture("comments");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.parent.body).toBe("Implement the requested feature.");
    expect(
      state.tickets.every(
        (ticket: { body: string }) => ticket.body === "Implement the requested feature.",
      ),
    ).toBe(true);
    const workers = readFileSync(join(f.root, "workers.jsonl"), "utf8");
    expect(workers).not.toContain("UNTRUSTED_COMMENT_INSTRUCTION");
    expect(workers).toContain("Implement the requested feature.");
  },
  30_000,
);

cliTest.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
  "refuses incompatible version-%s snapshots before launching workers",
  async (version) => {
    const f = fixture("fail");
    const first = await f.start();
    const runDir = runDirFrom(first.stdout);
    const statePath = join(runDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.version = version;
    state.parent.body += "\n\n## Issue comments\n\nUNTRUSTED_COMMENT_INSTRUCTION";
    writeFileSync(statePath, JSON.stringify(state));
    const head = f.git("-C", state.worktree, "rev-parse", "HEAD");
    const result = await f.run("resume", runDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("older snapshots may include issue comments");
    expect(readFileSync(join(f.root, "workers.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    // The rejected run's state and worktree are left exactly as they were.
    expect(readFileSync(statePath, "utf8")).toBe(JSON.stringify(state));
    expect(f.git("-C", state.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(runDir, "run.lock"))).toBe(false);
  },
  30_000,
);

cliTest.each([
  ["parent-order", [12, 11]],
  ["parent-order-dependency", [11, 12]],
] as const)(
  "preserves parent order while respecting dependencies (%s)",
  async (mode, expected) => {
    const f = fixture(mode);
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.tickets.map((ticket: { number: number }) => ticket.number)).toEqual([12, 11]);
    const workers = readFileSync(join(f.root, "workers.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      workers
        .filter((worker) => worker.name.includes("implement"))
        .map((worker) => Number(worker.name.match(/#(\d+) implement/)[1])),
    ).toEqual(expected);
  },
  30_000,
);

cliTest(
  "preserves UTF-8 issue text split across stdout chunks",
  async () => {
    const f = fixture("unicode");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.parent.body).toBe("Price €5.");
    expect(state.tickets.every((ticket: { body: string }) => ticket.body === "Price €5.")).toBe(
      true,
    );
    expect(readFileSync(join(f.root, "workers.jsonl"), "utf8")).not.toContain("�");
  },
  30_000,
);

cliTest(
  "preserves UTF-8 error text split across stderr chunks",
  async () => {
    const f = fixture("unicode-error");
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Provider says café");
    const runDir = runDirFrom(result.stdout);
    expect(readSummary(runDir)).toContain("Provider says café");
  },
  30_000,
);

cliTest(
  "reports the signal when a worker is terminated externally",
  async () => {
    const f = fixture("signal-exit");
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pi terminated by SIGTERM");
    expect(result.stderr).not.toContain("exited null");
  },
  30_000,
);

cliTest.each(["missing-lock", "directory-lock"])(
  "preserves the primary error if lock cleanup fails (%s)",
  async (mode) => {
    const f = fixture(mode);
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Provider unavailable");
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("blocked");
    expect(state.lastError).toContain("Provider unavailable");
    if (mode === "directory-lock")
      expect(result.stderr).toContain("Warning: could not remove run lock");
    else expect(result.stderr).not.toContain("ENOENT");
  },
  30_000,
);
