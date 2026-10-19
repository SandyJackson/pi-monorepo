// Helper units, run locks, and setup-failure resume.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { cliTest, fixture, readState, runDirFrom } from "./cli-fixture.ts";
import { gh, githubHostFromOrigin } from "./github.ts";
import { loadLoopSettings } from "./settings.ts";

it("derives the GitHub host from common origin URL forms", () => {
  expect(githubHostFromOrigin("git@github.com:owner/repo.git")).toBe("github.com");
  expect(githubHostFromOrigin("git@ghe.example.com:owner/repo.git")).toBe("ghe.example.com");
  expect(githubHostFromOrigin("https://github.com/owner/repo.git")).toBe("github.com");
  expect(githubHostFromOrigin("https://ghe.example.com/owner/repo")).toBe("ghe.example.com");
  expect(githubHostFromOrigin("ssh://git@ghe.example.com/owner/repo.git")).toBe("ghe.example.com");
  expect(githubHostFromOrigin("/tmp/remote.git")).toBeUndefined();
});

it("rejects a gh call when the inherited GH_HOST targets another host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-loop-gh-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const saved = process.env.GH_HOST;
  process.env.GH_HOST = "other.example.com";
  try {
    await expect(gh(dir, "github.com", "api", "x")).rejects.toThrow("GH_HOST");
  } finally {
    if (saved === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = saved;
  }
});

it("forces the origin host on gh calls instead of inheriting the environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-loop-gh-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "env.txt");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$GH_HOST" > "$STUB_OUT"\nprintf '{}\\n'\n`, {
    mode: 0o755,
  });
  const savedPath = process.env.PATH;
  const savedGhHost = process.env.GH_HOST;
  const savedStubOut = process.env.STUB_OUT;
  process.env.PATH = `${dir}:${savedPath}`;
  process.env.STUB_OUT = out;
  try {
    delete process.env.GH_HOST;
    expect(await gh(dir, "github.com", "api", "x")).toBe("{}");
    expect(readFileSync(out, "utf8").trim()).toBe("github.com");
    process.env.GH_HOST = "github.com";
    expect(await gh(dir, "github.com", "api", "x")).toBe("{}");
    process.env.GH_HOST = "ghe.example.com";
    expect(await gh(dir, undefined, "api", "x")).toBe("{}");
    expect(readFileSync(out, "utf8").trim()).toBe("ghe.example.com");
  } finally {
    process.env.PATH = savedPath!;
    if (savedGhHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = savedGhHost;
    if (savedStubOut === undefined) delete process.env.STUB_OUT;
    else process.env.STUB_OUT = savedStubOut;
  }
});

it("normalizes an empty agent tools list to the role defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-loop-settings-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "agents"), { recursive: true });
  for (const role of ["implement", "review"]) {
    writeFileSync(
      join(dir, "agents", `${role}.md`),
      `---\ndescription: Test ${role}\nmodel: test-provider/model\ntools: []\n---\n\nGuidance.`,
      "utf8",
    );
  }
  writeFileSync(
    join(dir, "loop-settings.json"),
    JSON.stringify({
      implementAgent: "./agents/implement.md",
      reviewAgent: "./agents/review.md",
      extensions: [],
    }),
    "utf8",
  );
  const settings = loadLoopSettings(join(dir, "loop-settings.json"));
  expect(settings.implement.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
  expect(settings.review.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
});

cliTest(
  "leaves a replaced run lock for its new owner",
  async () => {
    const f = fixture("replace-lock");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    expect(readFileSync(join(runDir, "run.lock"), "utf8")).toBe("new-owner\n");
    expect(result.stderr).toContain("replaced");
  },
  30_000,
);

cliTest(
  "can resume a setup failure in the already-created worktree",
  async () => {
    const f = fixture();
    const setup = `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('setup-ready')"`;
    const first = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--setup",
      setup,
    );
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const state = readState(runDir);
    writeFileSync(join(state.worktree, "setup-ready"), "ready");
    // Setup artifacts would normally be ignored dependency directories.
    writeFileSync(join(f.root, "ignore"), "setup-ready\n");
    f.git("config", "core.excludesFile", join(f.root, "ignore"));
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
  },
  30_000,
);
