import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest, fixture, readState, runDirFrom } from "./cli-fixture.ts";

function startFrom(f: ReturnType<typeof fixture>, base: string) {
  return f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true", "--base", base);
}

function pushBase(f: ReturnType<typeof fixture>): string {
  f.git("checkout", "-b", "tests/audit");
  writeFileSync(join(f.repo, "base.txt"), "Remote base\n");
  f.git("add", "base.txt");
  f.git("commit", "-m", "Remote base");
  f.git("push", "origin", "tests/audit");
  return f.git("rev-parse", "HEAD");
}

cliTest(
  "starts from the selected remote branch, excludes local changes, and targets its PR there",
  async () => {
    const f = fixture();
    const baseSha = pushBase(f);
    writeFileSync(join(f.repo, "local.txt"), "Unpushed commit\n");
    f.git("add", "local.txt");
    f.git("commit", "-m", "Local only");
    writeFileSync(join(f.repo, "base.txt"), "Uncommitted edit\n");
    const localHead = f.git("rev-parse", "HEAD");

    const result = await startFrom(f, "tests/audit");
    expect(result.status, result.stderr).toBe(0);
    const state = readState(runDirFrom(result));
    expect(state.status).toBe("done");
    expect(state.baseBranch).toBe("tests/audit");
    expect(state.baseSha).toBe(baseSha);
    expect(state.tickets[0].baseline).toBe(baseSha);
    expect(readFileSync(join(state.worktree, "base.txt"), "utf8")).toBe("Remote base\n");
    expect(existsSync(join(state.worktree, "local.txt"))).toBe(false);
    expect(f.git("branch", "--show-current")).toBe("tests/audit");
    expect(f.git("rev-parse", "HEAD")).toBe(localHead);
    expect(readFileSync(join(f.repo, "base.txt"), "utf8")).toBe("Uncommitted edit\n");
    const prArgs: string[] = JSON.parse(readFileSync(join(f.root, "pr.json"), "utf8"));
    expect(prArgs[prArgs.indexOf("--base") + 1]).toBe("tests/audit");
  },
  30_000,
);

cliTest(
  "resume keeps the selected branch and pinned commit when the remote advances",
  async () => {
    const f = fixture("publish-fail");
    const baseSha = pushBase(f);
    const first = await startFrom(f, "tests/audit");
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first);
    expect(readState(runDir).baseSha).toBe(baseSha);

    writeFileSync(join(f.repo, "later.txt"), "Later remote commit\n");
    f.git("add", "later.txt");
    f.git("commit", "-m", "Advance base");
    f.git("push", "origin", "tests/audit");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const state = readState(runDir);
    expect(state.status).toBe("done");
    expect(state.baseBranch).toBe("tests/audit");
    expect(state.baseSha).toBe(baseSha);
    expect(existsSync(join(state.worktree, "later.txt"))).toBe(false);
    const calls: string[][] = readFileSync(join(f.root, "gh-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const lookups = calls.filter((args) => args[0] === "pr" && args[1] === "list");
    expect(lookups).toHaveLength(2);
    expect(lookups.every((args) => args[args.indexOf("--base") + 1] === "tests/audit")).toBe(true);
  },
  30_000,
);

cliTest.each(["", "bad..branch", "missing-branch"])(
  "rejects invalid or missing remote base %j before creating a run or launching workers",
  async (base) => {
    const f = fixture();
    const result = await startFrom(f, base);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("Run directory:");
    expect(existsSync(join(f.root, ".pi-issue-loops"))).toBe(false);
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
  },
);
