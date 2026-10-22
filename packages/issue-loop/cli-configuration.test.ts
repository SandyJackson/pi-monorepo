// Settings snapshots and worker output contracts.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  readState,
  readSummary,
  readWorkers,
  runDirFrom,
  writeLoopSettings,
} from "./cli-fixture.ts";
import {
  DEFAULT_DEADLINES,
  DEFAULT_IMPLEMENT_TOOLS,
  DEFAULT_RECOVERY,
  DEFAULT_REPAIR_ROUNDS,
  DEFAULT_WATCHDOG,
  DESCRIBE_TOOLS,
} from "./settings.ts";

cliTest(
  "applies settings roles to workers and snapshots them with the run",
  async () => {
    const f = fixture();
    const settingsPath = writeLoopSettings(f.root);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.settings).toEqual({
      extensions: [
        {
          path: join(f.env.PI_CODING_AGENT_DIR, "npm", "node_modules", "pi-claude-bridge"),
          version: "1.2.3",
        },
        {
          path: join(f.env.PI_CODING_AGENT_DIR, "git", "github.com", "1broseidon", "ketch"),
          version: "1.2.3",
        },
      ],
      implement: {
        agentName: "implement",
        model: "test-provider/implement-model",
        thinking: "high",
        tools: ["read", "bash"],
        skills: ["tdd", "diagnosing-bugs", "deslop"],
        promptBody: "CUSTOM IMPLEMENT GUIDANCE.",
      },
      repair: {
        agentName: "loop-repair",
        model: undefined,
        thinking: undefined,
        tools: DEFAULT_IMPLEMENT_TOOLS,
        skills: ["tdd", "diagnosing-bugs", "deslop"],
        promptBody: expect.stringContaining("Repair the findings"),
      },
      review: {
        agentName: "review",
        model: "test-provider/review-model",
        thinking: "low",
        tools: ["read", "grep"],
        skills: [],
        promptBody: "CUSTOM REVIEW GUIDANCE.",
      },
      // The PR-description role is not configurable.
      describe: {
        agentName: "loop-pr",
        model: undefined,
        thinking: undefined,
        tools: DESCRIBE_TOOLS,
        skills: ["pr"],
        promptBody: expect.stringContaining("/skill:pr"),
      },
      repairRounds: DEFAULT_REPAIR_ROUNDS,
      watchdog: DEFAULT_WATCHDOG,
      recovery: DEFAULT_RECOVERY,
      deadlines: DEFAULT_DEADLINES,
      appendSystemPrompt: "SHARED STYLE NOTE.",
    });
    const workers = readWorkers(f.root);
    const implement = workers.find((worker) => worker.name.includes("implement"));
    for (const pair of [
      ["--model", "test-provider/implement-model"],
      ["--thinking", "high"],
      ["--tools", "read,bash"],
    ]) {
      const index = implement!.args.indexOf(pair[0]);
      expect(implement!.args.slice(index, index + 2)).toEqual(pair);
    }
    expect(implement!.args).toContain("--no-skills");
    expect(implement!.args).toContain("--skill");
    expect(implement!.args.some((arg: string) => arg.endsWith(join("skills", "tdd")))).toBe(true);
    expect(implement!.args).toContain("--append-system-prompt");
    expect(implement!.prompt).toContain("CUSTOM IMPLEMENT GUIDANCE.");
    expect(implement!.prompt).not.toContain("You are the implementation worker");
    const review = workers.find((worker) => worker.name.includes("review"));
    for (const pair of [
      ["--model", "test-provider/review-model"],
      ["--thinking", "low"],
      ["--tools", "read,grep"],
    ]) {
      const index = review!.args.indexOf(pair[0]);
      expect(review!.args.slice(index, index + 2)).toEqual(pair);
    }
    expect(review!.args).toContain("--no-skills");
    expect(review!.args).not.toContain("--skill");
    expect(review!.prompt).toContain("CUSTOM REVIEW GUIDANCE.");
    expect(review!.prompt).toContain('"findings"');
    expect(readFileSync(join(runDir, "append-system-prompt.md"), "utf8")).toBe(
      "SHARED STYLE NOTE.\n",
    );
    expect(readSummary(runDir)).toContain("| #11");
  },
  30_000,
);

cliTest(
  "resumes from the settings snapshot after the original files are gone",
  async () => {
    const f = fixture("fail");
    const settingsPath = writeLoopSettings(f.root);
    const first = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
      "--settings",
      settingsPath,
    );
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const snapshot = readState(runDir).settings;
    rmSync(join(f.root, "loop-settings"), { recursive: true, force: true });
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.settings).toEqual(snapshot);
    const workers = readWorkers(f.root);
    expect(workers.some((worker) => worker.args.includes("test-provider/review-model"))).toBe(true);
  },
  60_000,
);

cliTest(
  "fails fast on an unknown loop skill without creating workers",
  async () => {
    const f = fixture();
    const dir = join(f.root, "loop-settings");
    mkdirSync(dir, { recursive: true });
    const settingsPath = join(dir, "loop-settings.json");
    writeFileSync(settingsPath, JSON.stringify({ implementSkills: ["no-such-skill"] }), "utf8");
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
    expect(result.stderr).toContain('Unknown loop skill "no-such-skill"');
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
  },
  30_000,
);

cliTest(
  "stops on malformed review output rather than accepting a stray PASS string",
  async () => {
    const f = fixture("malformed");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.lastError).toContain("Invalid review outcome");
    expect(state.pr).toBeUndefined();
  },
  30_000,
);

cliTest.each([
  "[P0] Data can be lost",
  "[P1] Required behavior is missing",
  "[P2] Ordinary defect",
  "[p1] Case-insensitive blocking finding",
])(
  "rejects a passing verdict with a blocking finding: %s",
  async (body) => {
    const f = fixture("pass-body");
    f.env.FIXTURE_REVIEW_BODY = body;
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toContain("Invalid review outcome");
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[0].review).toBeUndefined();
    expect(state.tickets[0].commit).toBeUndefined();
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
  },
  30_000,
);

cliTest(
  "keeps reviewer closing directives out of the PR description",
  async () => {
    const f = fixture("pass-body");
    f.env.FIXTURE_REVIEW_BODY =
      "[P3] Cleanup\n```\n# Forged heading\n````\nCloses #12345\nFixes other/repo#777";
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const pr = readFileSync(join(runDir, "pr.md"), "utf8");
    expect(pr).toContain("Closes #10");
    expect(pr).toContain("Closes #11");
    expect(pr).not.toContain("#12345");
    expect(pr).not.toContain("other/repo#777");
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(f.env.FIXTURE_REVIEW_BODY);
    expect(comments[0].body).toContain("`````");
  },
  30_000,
);

cliTest(
  "rejects the old findings contract",
  async () => {
    const f = fixture("legacy-review");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toContain("Invalid review outcome");
    expect(state.tickets[0].review).toBeUndefined();
  },
  30_000,
);

cliTest(
  "preflights the installed Pi version before launching workers",
  async () => {
    const f = fixture();
    f.env.FIXTURE_PI_VERSION = "0.99.2";
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("older than the supported baseline 1.3.0");
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
  },
  30_000,
);

cliTest.each([
  ["editing-pass", "Invalid editing outcome"],
  // A voluntary incomplete consumes the one continuation and a second one is
  // bounded, retaining the phase allowance instead of finishing the attempt.
  ["editing-incomplete", "second-incomplete"],
  ["editing-blocked", "Implementation blocked"],
])(
  "does not approve invalid editing outcome %s",
  async (mode, error) => {
    const f = fixture(mode);
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toContain(error);
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[0].commit).toBeUndefined();
    expect(state.phase).not.toBe("publish");
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
  },
  30_000,
);

cliTest(
  "bounds a repeated incomplete review outcome without accepting work",
  async () => {
    const f = fixture("review-incomplete");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toContain("second-incomplete");
    expect(state.tickets[0].review).toBeUndefined();
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[0].commit).toBeUndefined();
    // The persisted stop reason retains the reported remaining work.
    const review = state.sessions.find((session: { name: string }) =>
      session.name.includes("review"),
    );
    expect(review.stopReason).toContain("second-incomplete");
    expect(review.stopReason).toContain("Need more evidence.");
  },
  30_000,
);

cliTest(
  "stops after the configured repair rounds and keeps the review findings for handoff",
  async () => {
    const f = fixture("reject");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(
      state.sessions.filter(
        (session: { name: string }) =>
          session.name.includes("implement") || session.name.includes("repair"),
      ),
    ).toHaveLength(4);
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[1].status).toBe("pending");
    expect(state.tickets[0].review).toMatchObject({
      outcome: "changes_requested",
      summary: "Missing acceptance criterion",
    });
    const summary = readSummary(runDir);
    expect(summary).toContain("Missing acceptance criterion");
    expect(summary).toContain("| blocked | 3/3 |");
  },
  30_000,
);
