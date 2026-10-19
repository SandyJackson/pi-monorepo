import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest, fixture, readState, readWorkers, runDirFrom } from "./cli-fixture.ts";

cliTest.each(["publish-fail", "comment-create-fail"])(
  "refuses changed overrides after %s without altering state or publication, then allows ordinary recovery",
  async (mode) => {
    const f = fixture(mode);
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first);
    const statePath = join(runDir, "state.json");
    const original = readFileSync(statePath, "utf8");
    const before = readState(runDir);
    expect(before.phase).toBe("publish");
    // PR creation can succeed remotely without its URL reaching the controller.
    expect(Boolean(before.pr)).toBe(mode === "comment-create-fail");
    const pr = readFileSync(join(f.root, "pr.json"), "utf8");
    const description = readFileSync(join(runDir, "pr.md"), "utf8");
    const workers = readWorkers(f.root);
    const file = join(f.root, "operator.md");
    writeFileSync(file, "Approved updated requirements.");
    for (const args of [
      ["--check", "false"],
      ["--instructions-file", file],
      ["--check", "false", "--instructions-file", file],
    ]) {
      const result = await f.run("resume", runDir, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Cannot change checks or operator instructions after PR creation",
      );
      expect(readFileSync(statePath, "utf8")).toBe(original);
      expect(readFileSync(join(f.root, "pr.json"), "utf8")).toBe(pr);
      expect(readFileSync(join(runDir, "pr.md"), "utf8")).toBe(description);
      expect(readWorkers(f.root)).toEqual(workers);
      expect(existsSync(join(runDir, "run.lock"))).toBe(false);
    }
    const calls: string[][] = readFileSync(join(f.root, "gh-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === "pr" && args[1] === "create")).toHaveLength(1);
    expect(calls.some((args) => args[0] === "pr" && args[1] === "edit")).toBe(false);
    // Supplying the identical check is not an override and must not block recovery.
    const resumed = await f.run("resume", runDir, "--check", before.check);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readState(runDir).status).toBe("done");
    expect(readWorkers(f.root)).toEqual(workers);
  },
  30_000,
);
