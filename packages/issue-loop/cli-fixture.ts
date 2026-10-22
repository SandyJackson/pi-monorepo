import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, it } from "vitest";
import type { RunState } from "./state.ts";
import { installDefaultExtensions } from "./test-fixtures/extensions.ts";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
// Fixture-based CLI tests run concurrently within each file: each fixture owns
// its temporary directories and subprocess environment. Without this the
// longest file bounds the suite. `maxConcurrency` in vitest.config.ts caps the
// overlap so real Git and worker subprocesses do not saturate the machine.
export const cliTest: typeof it.concurrent = it.concurrent;
export const cli = resolve(import.meta.dirname, "run.mjs");

export function fixture(mode = "pass") {
  const root = mkdtempSync(join(tmpdir(), "issue-loop-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const path of [repo, bin, home]) mkdirSync(path);
  const agentDir = join(home, ".pi", "agent");
  installDefaultExtensions(agentDir);
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Loop Test",
    GIT_AUTHOR_EMAIL: "loop@example.test",
    GIT_COMMITTER_NAME: "Loop Test",
    GIT_COMMITTER_EMAIL: "loop@example.test",
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_ROOT: root,
    FIXTURE_MODE: mode,
    FIXTURE_REVIEW_BODY: "",
    FIXTURE_MODEL_EXTENSION: "",
    FIXTURE_MISSING_MODEL: "",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "A test project\n");
  git("add", ".");
  git("commit", "-m", "Initial commit");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  // Fake executables live in test-fixtures/ as plain CommonJS so they get
  // highlighting, lint, and isolated testing; the shebang pins the runner.
  const fixtureScripts = join(import.meta.dirname, "test-fixtures");
  const ghScript = readFileSync(join(fixtureScripts, "fake-gh.cjs"), "utf8");
  const piScript = readFileSync(join(fixtureScripts, "fake-pi.cjs"), "utf8");
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\n${ghScript}`, {
    mode: 0o755,
  });
  writeFileSync(join(bin, "pi"), `#!${process.execPath}\n${piScript}`, {
    mode: 0o755,
  });
  const run = async (...args: string[]) => {
    try {
      const result = await execFileAsync(process.execPath, [cli, ...args], {
        env: { ...env },
        encoding: "utf8",
        timeout: 30_000,
      });
      return { status: 0, ...result };
    } catch (error) {
      const failure = error as Error & { code?: number; stdout: string; stderr: string };
      if (typeof failure.code !== "number") throw error;
      return { status: failure.code, stdout: failure.stdout, stderr: failure.stderr };
    }
  };
  const start = () =>
    run(
      "start",
      "--repo",
      repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
    );
  return { root, repo, env, git, run, start };
}

/** Extract the run directory from CLI stdout. Throws when absent. */
export function runDirFrom(result: { stdout: string } | string): string {
  const stdout = typeof result === "string" ? result : result.stdout;
  const runDir = stdout.match(/Run directory: (.+)/)?.[1];
  if (!runDir) throw new Error("CLI output did not include a run directory");
  return runDir;
}

/** Parse the persisted run state for assertions. */
export function readState(runDir: string): RunState {
  return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
}

/** Read the human-readable run summary for assertions. */
export function readSummary(runDir: string): string {
  return readFileSync(join(runDir, "summary.md"), "utf8");
}

export function writeLoopSettings(root: string): string {
  const dir = join(root, "loop-settings");
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "agents", "implement.md"),
    `---\ndescription: Test implementer\nmodel: test-provider/implement-model\nthinking: high\ntools: read, bash\n---\n\nCUSTOM IMPLEMENT GUIDANCE.`,
    "utf8",
  );
  writeFileSync(
    join(dir, "agents", "review.md"),
    `---\ndescription: Test reviewer\nmodel: test-provider/review-model\nthinking: low\ntools: read, grep\n---\n\nCUSTOM REVIEW GUIDANCE.`,
    "utf8",
  );
  const settingsPath = join(dir, "loop-settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      implementAgent: "./agents/implement.md",
      reviewAgent: "./agents/review.md",
      appendSystemPrompt: "SHARED STYLE NOTE.",
    }),
    "utf8",
  );
  return settingsPath;
}

/** One persisted record from a fake Pi session file. */
export interface SessionRecord {
  type: string;
  message?: { role: string; content: { type: string; text: string }[] };
}

/** A worker launch as logged by the fake Pi; `historyBefore` is what it loaded from disk. */
export interface WorkerLaunch {
  name: string;
  session: string;
  args: string[];
  prompt: string;
  historyBefore: SessionRecord[];
}

export function readWorkers(root: string): WorkerLaunch[] {
  return readFileSync(join(root, "workers.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** Text of the messages with one role in a loaded session history. */
export function historyText(history: SessionRecord[], role: "user" | "assistant"): string[] {
  return history
    .filter((record) => record.type === "message" && record.message?.role === role)
    .map((record) => record.message!.content.map((part) => part.text).join("\n"));
}

/**
 * Run a real `start` and kill the controller from a post-commit hook after Git
 * has created the commit but before the run records it, then let the detached
 * Git process release the worktree index lock. This is an interruption window,
 * not a state rewrite: the persisted intent and the real commit disagree only
 * because the controller died between Git and state persistence.
 */
export async function startThenKillAfterCommit(f: ReturnType<typeof fixture>, prelude = "") {
  const hooks = join(f.repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, "post-commit"),
    `#!/bin/sh\n${prelude}if [ ! -f ../hook-killed ]; then\n  touch ../hook-killed\n  kill -9 "$(cat ../run.lock)" 2>/dev/null\nfi\n`,
    { mode: 0o755 },
  );
  const child = spawn(
    process.execPath,
    [cli, "start", "--repo", f.repo, "--issue", "10", "--check", "true"],
    { env: f.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (data) => (stdout += data.toString()));
  child.stderr.resume();
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  const runDir = runDirFrom(stdout);
  const worktree = join(runDir, "worktree");
  for (let i = 0; i < 100; i++) {
    try {
      f.git("-C", worktree, "status", "--porcelain");
      break;
    } catch {
      await delay(50);
    }
  }
  return { runDir, worktree, state: readState(runDir) };
}

/**
 * Fixture watchdog allowances for real-subprocess stall tests. Silence must
 * outlast a healthy worker's startup under the concurrent suite, and the grace
 * periods must outlast a loaded suite delivering the checkpoint steer and the
 * abort response. Only the fixture uses these; production defaults are unchanged.
 */
export const WATCHDOG_SILENCE_MS = 2_000;
export const WATCHDOG_CHECKPOINT_GRACE_MS = 2_000;
export const WATCHDOG_ABORT_GRACE_MS = 1_000;

export function writeWatchdogSettings(root: string, silenceMs = WATCHDOG_SILENCE_MS): string {
  const settingsPath = join(root, "watchdog-settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      watchdog: {
        silenceMs,
        toolMs: 100_000,
        softCheckpointMs: 100_000,
        hardCeilingMs: 100_000,
        checkpointGraceMs: WATCHDOG_CHECKPOINT_GRACE_MS,
        abortGraceMs: WATCHDOG_ABORT_GRACE_MS,
        sigkillEscalationMs: 100,
      },
      recovery: { transientRetries: 2, transientBackoffMs: [1, 1] },
    }),
    "utf8",
  );
  return settingsPath;
}
