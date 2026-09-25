import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { gh, githubHostFromOrigin } from "./github.ts";
import { loadLoopSettings } from "./settings.ts";

const roots: string[] = [];
const cli = resolve(import.meta.dirname, "run.mjs");

function fixture(mode = "pass") {
  const root = mkdtempSync(join(tmpdir(), "issue-loop-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const path of [repo, bin, home]) mkdirSync(path);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Loop Test",
    GIT_AUTHOR_EMAIL: "loop@example.test",
    GIT_COMMITTER_NAME: "Loop Test",
    GIT_COMMITTER_EMAIL: "loop@example.test",
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_ROOT: root,
    FIXTURE_MODE: mode,
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
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
const mode = process.env.FIXTURE_MODE;
const issue = n => ({number:n, title:n === 10 ? 'Parent feature' : 'Ticket '+n, body:mode === 'unicode' ? 'Price €5.' : 'Implement the requested feature.', state:'open', html_url:'https://github.com/test/project/issues/'+n});
let result;
if (args[0] === 'repo' && args[1] === 'view') result = {nameWithOwner:process.env.GH_REPO && args[2] === '--json' ? process.env.GH_REPO : 'test/project', defaultBranchRef:{name:'main'}};
else if (args[0] === 'api') {
 const endpoint = args.find(a => a.startsWith('repos/'));
 if (endpoint.endsWith('/sub_issues')) result = mode === 'empty' ? [[]] : mode.startsWith('parent-order') ? [[issue(12)], [issue(11)]] : [[issue(11)], [issue(12)]];
 else if (endpoint.endsWith('/dependencies/blocked_by')) result = [mode === 'parent-order' ? [] : endpoint.includes('/12/') ? [issue(11)] : mode === 'cycle' ? [issue(12)] : []];
 else if (endpoint.endsWith('/comments')) result = mode === 'comments' ? [[{body:'UNTRUSTED_COMMENT_INSTRUCTION'}]] : [[]];
 else result = issue(Number(endpoint.split('/').pop()));
} else if (args[0] === 'pr' && args[1] === 'list') result = fs.existsSync(path.join(root, 'pr.json')) ? [{url:'https://github.com/test/project/pull/99', state:'OPEN'}] : [];
else if (args[0] === 'pr' && args[1] === 'create') {
 fs.writeFileSync(path.join(root, 'pr.json'), JSON.stringify(args));
 fs.appendFileSync(path.join(root, 'pr-created.txt'), 'created\\n');
 if (mode === 'publish-fail') { console.error('Connection lost after creating PR'); process.exit(1); }
 console.log('https://github.com/test/project/pull/99'); process.exit(0);
} else {console.error('Unexpected gh args', args); process.exit(2);}
const output = Buffer.from(JSON.stringify(result));
const split = mode === 'unicode' ? output.indexOf(Buffer.from('€')) : -1;
if (split >= 0) {
 process.stdout.write(output.subarray(0, split + 1));
 setTimeout(() => process.stdout.end(output.subarray(split + 1)), 50);
} else console.log(output.toString());
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "pi"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag)+1];
const name = value('--name');
const session = value('--session');
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(session, JSON.stringify({type:'session_info', name})+'\\n');
fs.appendFileSync(path.join(process.env.FIXTURE_ROOT, 'workers.jsonl'), JSON.stringify({name, session, args, prompt, cwd:process.cwd()})+'\\n');
if (name.includes('implement')) {
 if (process.env.FIXTURE_MODE === 'signal-exit') process.kill(process.pid, 'SIGTERM');
 if (process.env.FIXTURE_MODE === 'replace-lock') {
   const lock = path.join(path.dirname(path.dirname(session)), 'run.lock');
   fs.unlinkSync(lock);
   fs.writeFileSync(lock, 'new-owner\\n');
 }
 if (process.env.FIXTURE_MODE === 'missing-lock' || process.env.FIXTURE_MODE === 'directory-lock') {
   const lock = path.join(path.dirname(path.dirname(session)), 'run.lock');
   fs.unlinkSync(lock);
   if (process.env.FIXTURE_MODE === 'directory-lock') fs.mkdirSync(lock);
   console.error('Provider unavailable'); process.exit(1);
 }
 if (process.env.FIXTURE_MODE === 'unicode-error') {
   const output = Buffer.from('Provider says café');
   const split = output.indexOf(Buffer.from('é'));
   process.stderr.write(output.subarray(0, split + 1));
   setTimeout(() => { process.stderr.write(output.subarray(split + 1)); process.exitCode = 1; }, 50);
 } else if (process.env.FIXTURE_MODE === 'stubborn') {
   process.on('SIGTERM', () => {});
   fs.writeFileSync(path.join(process.env.FIXTURE_ROOT, 'stubborn.pid'), String(process.pid));
   setInterval(() => {}, 1000);
 } else if (process.env.FIXTURE_MODE === 'commit-fail') {
   require('node:child_process').execFileSync('git', ['commit', '--allow-empty', '-m', 'Unauthorized worker commit']);
   process.exit(1);
 } else if (process.env.FIXTURE_MODE === 'fail') {console.error('Provider unavailable'); process.exit(1);}
 fs.writeFileSync('feature.txt', 'implemented\\n');
 console.log('Implemented the requested ticket.');
} else if (process.env.FIXTURE_MODE === 'malformed') console.log('PASS, probably.');
else if (process.env.FIXTURE_MODE === 'legacy-review') console.log(JSON.stringify({verdict:'pass', findings:[]}));
else if (process.env.FIXTURE_MODE === 'reject' || (process.env.FIXTURE_MODE === 'parent-reject' && name.includes('parent review'))) console.log(JSON.stringify({verdict:'changes_requested', body:'Missing acceptance criterion'}));
else if (process.env.FIXTURE_MODE === 'blocked-review') console.log(JSON.stringify({verdict:'blocked', body:'Cannot assess required behavior'}));
else if (process.env.FIXTURE_MODE === 'pass-notes') console.log(JSON.stringify({verdict:'pass', body: name.includes('parent review') ? '[Standards][Minor] Parent cleanup' : '[Spec][Minor] Ticket cleanup'}));
else console.log(JSON.stringify({verdict:'pass', body:''}));
`,
    { mode: 0o755 },
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 30_000 });
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("accepts dependent tickets on one branch and opens one final PR without closing issues", () => {
  const f = fixture();
  const result = f.start();
  expect(result.status, result.stderr).toBe(0);
  const runDir = result.stdout.match(/Run directory: (.+)/)?.[1];
  expect(runDir).toBeTruthy();
  const state = JSON.parse(readFileSync(join(runDir!, "state.json"), "utf8"));
  expect(state.status).toBe("done");
  expect(state.tickets.map((ticket: { status: string }) => ticket.status)).toEqual([
    "accepted",
    "accepted",
  ]);
  expect(f.git("branch", "--show-current")).toBe("main");
  const summary = readFileSync(join(runDir!, "summary.md"), "utf8");
  expect(summary).toContain("https://github.com/test/project/pull/99");
  const workers = readFileSync(join(f.root, "workers.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(workers.every((worker) => worker.name.startsWith(state.name))).toBe(true);
  expect(new Set(workers.map((worker) => worker.session)).size).toBe(workers.length);
  const reviews = workers.filter((worker) => worker.name.includes("review"));
  expect(reviews.length).toBeGreaterThanOrEqual(3);
  expect(reviews.every((worker) => worker.args.includes("read,grep,find,ls"))).toBe(true);
  expect(workers.every((worker) => worker.args.includes("--no-skills"))).toBe(true);
  // Blessed defaults: implementers get the curated trio, reviewers get none.
  const implementers = workers.filter((worker) => worker.name.includes("implement"));
  expect(implementers.length).toBeGreaterThan(0);
  expect(
    implementers.every(
      (worker) =>
        worker.args.includes("--skill") &&
        worker.args.some((arg: string) => arg.endsWith(join("skills", "tdd"))) &&
        worker.args.some((arg: string) => arg.endsWith(join("skills", "deslop"))),
    ),
  ).toBe(true);
  expect(reviews.every((worker) => !worker.args.includes("--skill"))).toBe(true);
  expect(existsSync(join(runDir!, "skills", "tdd", "SKILL.md"))).toBe(true);
  expect(existsSync(join(runDir!, "skills", "diagnosing-bugs", "SKILL.md"))).toBe(true);
  const prArgs = JSON.parse(readFileSync(join(f.root, "pr.json"), "utf8"));
  expect(prArgs).toContain("--base");
  expect(prArgs).toContain("main");
}, 30_000);

it("keeps passing review bodies for tickets and parent without starting repairs", () => {
  const f = fixture("pass-notes");
  const result = f.start();
  expect(result.status, result.stderr).toBe(0);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.status).toBe("done");
  expect(state.tickets.every((ticket: { repairs: number }) => ticket.repairs === 0)).toBe(true);
  expect(
    state.tickets.every(
      (ticket: { review: { verdict: string; body: string } }) =>
        ticket.review.verdict === "pass" && ticket.review.body === "[Spec][Minor] Ticket cleanup",
    ),
  ).toBe(true);
  expect(state.review).toEqual({ verdict: "pass", body: "[Standards][Minor] Parent cleanup" });
  const summary = readFileSync(join(runDir, "summary.md"), "utf8");
  expect(summary).toContain("[Spec][Minor] Ticket cleanup");
  expect(summary).toContain("[Standards][Minor] Parent cleanup");
  const pr = readFileSync(join(runDir, "pr.md"), "utf8");
  expect(pr).toContain("[Spec][Minor] Ticket cleanup");
  expect(pr).toContain("[Standards][Minor] Parent cleanup");
}, 30_000);

it("persists a blocked review body before stopping", () => {
  const f = fixture("blocked-review");
  const result = f.start();
  expect(result.status).toBe(1);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.tickets[0].review).toEqual({
    verdict: "blocked",
    body: "Cannot assess required behavior",
  });
  expect(state.tickets[0].repairs).toBe(0);
}, 30_000);

it("preserves a first-ticket failure, then reviews manual fixes on resume without repeating implementation", () => {
  const f = fixture("fail");
  const first = f.start();
  expect(first.status).toBe(1);
  const runDir = first.stdout.match(/Run directory: (.+)/)![1];
  const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(blocked.status).toBe("blocked");
  expect(blocked.tickets.map((ticket: { status: string }) => ticket.status)).toEqual([
    "blocked",
    "pending",
  ]);
  expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("Provider unavailable");
  expect(blocked.sessions[0].name).toContain("#11 implement · attempt 1");
  writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
  f.env.FIXTURE_MODE = "pass";
  const resumed = f.run("resume", runDir);
  expect(resumed.status, resumed.stderr).toBe(0);
  const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(finished.status).toBe("done");
  expect(finished.name).toBe(blocked.name);
  expect(
    finished.sessions.filter((session: { name: string }) => session.name.includes("#11 implement")),
  ).toHaveLength(1);
  expect(finished.sessions[1].name).toContain("#11 review · attempt 1");
  expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("pi --session");
}, 30_000);

function writeLoopSettings(root: string): string {
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

function readWorkers(root: string): { name: string; args: string[]; prompt: string }[] {
  return readFileSync(join(root, "workers.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

it("applies settings roles to workers and snapshots them with the run", () => {
  const f = fixture();
  const settingsPath = writeLoopSettings(f.root);
  const result = f.run(
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
  const runDir = result.stdout.match(/Run directory: (.+)/)?.[1];
  const state = JSON.parse(readFileSync(join(runDir!, "state.json"), "utf8"));
  expect(state.settings).toEqual({
    implement: {
      agentName: "implement",
      model: "test-provider/implement-model",
      thinking: "high",
      tools: ["read", "bash"],
      skills: ["tdd", "diagnosing-bugs", "deslop"],
      promptBody: "CUSTOM IMPLEMENT GUIDANCE.",
    },
    review: {
      agentName: "review",
      model: "test-provider/review-model",
      thinking: "low",
      tools: ["read", "grep"],
      skills: [],
      promptBody: "CUSTOM REVIEW GUIDANCE.",
    },
    appendSystemPrompt: "SHARED STYLE NOTE.",
  });
  const workers = readWorkers(f.root);
  const implement = workers.find((worker) => worker.name.includes("implement"));
  expect(implement!.args).toContain("--model");
  expect(implement!.args).toContain("test-provider/implement-model");
  expect(implement!.args).toContain("--thinking");
  expect(implement!.args).toContain("high");
  expect(implement!.args).toContain("--tools");
  expect(implement!.args).toContain("read,bash");
  expect(implement!.args).toContain("--no-skills");
  expect(implement!.args).toContain("--skill");
  expect(implement!.args.some((arg: string) => arg.endsWith(join("skills", "tdd")))).toBe(true);
  expect(implement!.args).toContain("--append-system-prompt");
  expect(implement!.prompt).toContain("CUSTOM IMPLEMENT GUIDANCE.");
  expect(implement!.prompt).not.toContain("You are the implementation worker");
  const review = workers.find((worker) => worker.name.includes("review"));
  expect(review!.args).toContain("test-provider/review-model");
  expect(review!.args).toContain("--thinking");
  expect(review!.args).toContain("low");
  expect(review!.args).toContain("read,grep");
  expect(review!.args).toContain("--no-skills");
  expect(review!.args).not.toContain("--skill");
  expect(review!.prompt).toContain("CUSTOM REVIEW GUIDANCE.");
  expect(review!.prompt).toContain('"verdict"');
  expect(readFileSync(join(runDir!, "append-system-prompt.md"), "utf8")).toBe(
    "SHARED STYLE NOTE.\n",
  );
  expect(readFileSync(join(runDir!, "summary.md"), "utf8")).toContain("| #11");
}, 30_000);

it("resumes from the settings snapshot after the original files are gone", () => {
  const f = fixture("fail");
  const settingsPath = writeLoopSettings(f.root);
  const first = f.run(
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
  const runDir = first.stdout.match(/Run directory: (.+)/)![1];
  const snapshot = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).settings;
  rmSync(join(f.root, "loop-settings"), { recursive: true, force: true });
  f.env.FIXTURE_MODE = "pass";
  const resumed = f.run("resume", runDir);
  expect(resumed.status, resumed.stderr).toBe(0);
  const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(finished.status).toBe("done");
  expect(finished.settings).toEqual(snapshot);
  const workers = readWorkers(f.root);
  expect(workers.some((worker) => worker.args.includes("test-provider/review-model"))).toBe(true);
}, 60_000);

it("fails fast on an unknown loop skill without creating workers", () => {
  const f = fixture();
  const dir = join(f.root, "loop-settings");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "loop-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ implementSkills: ["no-such-skill"] }), "utf8");
  const result = f.run(
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
}, 30_000);

it("stops on malformed review output rather than accepting a stray PASS string", () => {
  const f = fixture("malformed");
  const result = f.start();
  expect(result.status).toBe(1);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.tickets[0].status).toBe("blocked");
  expect(state.lastError).toContain("invalid verdict");
  expect(state.pr).toBeUndefined();
}, 30_000);

it("rejects the old findings contract", () => {
  const f = fixture("legacy-review");
  const result = f.start();
  expect(result.status).toBe(1);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.lastError).toContain("invalid verdict");
  expect(state.tickets[0].review).toBeUndefined();
}, 30_000);

it("stops after two repair attempts and keeps the review findings for handoff", () => {
  const f = fixture("reject");
  const result = f.start();
  expect(result.status).toBe(1);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(
    state.sessions.filter((session: { name: string }) => session.name.includes("implement")),
  ).toHaveLength(3);
  expect(state.tickets[0].status).toBe("blocked");
  expect(state.tickets[1].status).toBe("pending");
  expect(state.tickets[0].review).toEqual({
    verdict: "changes_requested",
    body: "Missing acceptance criterion",
  });
  const summary = readFileSync(join(runDir, "summary.md"), "utf8");
  expect(summary).toContain("Missing acceptance criterion");
  expect(summary).toContain("| blocked | 2/2 |");
}, 30_000);

it("finds an already-created PR after publication was interrupted", () => {
  const f = fixture("publish-fail");
  const first = f.start();
  expect(first.status).toBe(1);
  const runDir = first.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.phase).toBe("publish");
  const resumed = f.run("resume", runDir);
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
  expect(f.run("resume", runDir).status).toBe(0);
  expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
}, 30_000);

it("reports a dependency cycle without starting a worker or publishing", () => {
  const f = fixture("cycle");
  const result = f.start();
  expect(result.status).toBe(1);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.sessions).toEqual([]);
  expect(state.lastError).toContain("dependency cycle");
  expect(state.status).toBe("blocked");
}, 30_000);

it("rejects an empty queue rather than claiming the parent is complete", () => {
  const f = fixture("empty");
  const result = f.start();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No open direct child issues");
}, 30_000);

it("rejects a timeout below the minimum before launching workers", () => {
  const f = fixture();
  const result = f.run(
    "start",
    "--repo",
    f.repo,
    "--issue",
    "10",
    "--check",
    "true",
    "--timeout",
    "1",
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--timeout must be 300 to 7200 seconds");
  expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
}, 30_000);

it("rechecks manual edits made after a publication failure", () => {
  const f = fixture("publish-fail");
  const first = f.start();
  const runDir = first.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  writeFileSync(join(state.worktree, "feature.txt"), "Manual integration fix\n");
  const resumed = f.run("resume", runDir);
  expect(resumed.status, resumed.stderr).toBe(0);
  const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(
    finished.sessions.filter((session: { name: string }) => session.name.includes("parent review")),
  ).toHaveLength(2);
  expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toBe(
    "Manual integration fix\n",
  );
}, 30_000);

it.each(["reject", "parent-reject"])(
  "does not replenish an exhausted repair budget on resume (%s)",
  (mode) => {
    const f = fixture(mode);
    const first = f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const before = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const implementations = (state: typeof before) =>
      state.sessions.filter((session: { name: string }) => session.name.includes("implement"))
        .length;
    expect(f.run("resume", runDir).status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(implementations(after)).toBe(implementations(before));
    // A human fix can still be verified after the automatic repair budget is gone.
    f.env.FIXTURE_MODE = "pass";
    expect(f.run("resume", runDir).status).toBe(0);
  },
  30_000,
);

it("binds GitHub operations to origin instead of an inherited GH_REPO", () => {
  const f = fixture();
  Object.assign(f.env, { GH_REPO: "wrong/repository" });
  const result = f.start();
  expect(result.status, result.stderr).toBe(0);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  expect(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).githubRepo).toBe(
    "test/project",
  );
}, 30_000);

it("refuses to resume after origin is changed", () => {
  const f = fixture("fail");
  const first = f.start();
  const runDir = first.stdout.match(/Run directory: (.+)/)![1];
  f.git("remote", "set-url", "origin", "https://github.com/wrong/repository.git");
  const result = f.run("resume", runDir);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("origin");
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.sessions).toHaveLength(1);
}, 30_000);

it("reports a forbidden HEAD change even when the worker exits unsuccessfully", () => {
  const f = fixture("commit-fail");
  const result = f.start();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("HEAD changed outside the controller");
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.tickets[0].status).toBe("blocked");
}, 30_000);

it("handles repeated interrupts without leaving a detached worker running", async () => {
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
    const runDir = output.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
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
}, 30_000);

it("rejects origin with multiple push destinations", () => {
  const f = fixture();
  const origin = f.git("remote", "get-url", "origin");
  f.git("config", "--add", "remote.origin.pushurl", origin);
  f.git("config", "--add", "remote.origin.pushurl", join(f.root, "unintended.git"));
  const result = f.start();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("exactly one");
  expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
}, 30_000);

it("checks worktree-local remote settings before publication", () => {
  const f = fixture("publish-fail");
  const first = f.start();
  const runDir = first.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  f.git("config", "extensions.worktreeConfig", "true");
  f.git(
    "-C",
    state.worktree,
    "config",
    "--worktree",
    "remote.origin.pushurl",
    join(f.root, "unintended.git"),
  );
  const resumed = f.run("resume", runDir);
  expect(resumed.status).toBe(1);
  expect(resumed.stderr).toContain("origin must have exactly one");
}, 30_000);

it("omits issue comments from saved requirements and every worker prompt", () => {
  const f = fixture("comments");
  const result = f.start();
  expect(result.status, result.stderr).toBe(0);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.parent.body).toBe("Implement the requested feature.");
  expect(
    state.tickets.every(
      (ticket: { body: string }) => ticket.body === "Implement the requested feature.",
    ),
  ).toBe(true);
  const workers = readFileSync(join(f.root, "workers.jsonl"), "utf8");
  expect(workers).not.toContain("UNTRUSTED_COMMENT_INSTRUCTION");
  expect(workers).toContain("Implement the requested feature.");
}, 30_000);

it("refuses old snapshots that may already contain untrusted comments", () => {
  const f = fixture("fail");
  const first = f.start();
  const runDir = first.stdout.match(/Run directory: (.+)/)![1];
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.version = 1;
  state.parent.body += "\n\n## Issue comments\n\nUNTRUSTED_COMMENT_INSTRUCTION";
  writeFileSync(statePath, JSON.stringify(state));
  const result = f.run("resume", runDir);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("older snapshots may include issue comments");
  expect(readFileSync(join(f.root, "workers.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
}, 30_000);

it.each([
  ["parent-order", [12, 11]],
  ["parent-order-dependency", [11, 12]],
] as const)(
  "preserves parent order while respecting dependencies (%s)",
  (mode, expected) => {
    const f = fixture(mode);
    const result = f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
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

it("preserves UTF-8 issue text split across stdout chunks", () => {
  const f = fixture("unicode");
  const result = f.start();
  expect(result.status, result.stderr).toBe(0);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  expect(state.parent.body).toBe("Price €5.");
  expect(state.tickets.every((ticket: { body: string }) => ticket.body === "Price €5.")).toBe(true);
  expect(readFileSync(join(f.root, "workers.jsonl"), "utf8")).not.toContain("�");
}, 30_000);

it("preserves UTF-8 error text split across stderr chunks", () => {
  const f = fixture("unicode-error");
  const result = f.start();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Provider says café");
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("Provider says café");
}, 30_000);

it("reports the signal when a worker is terminated externally", () => {
  const f = fixture("signal-exit");
  const result = f.start();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("pi terminated by SIGTERM");
  expect(result.stderr).not.toContain("exited null");
}, 30_000);

it.each(["missing-lock", "directory-lock"])(
  "preserves the primary error if lock cleanup fails (%s)",
  (mode) => {
    const f = fixture(mode);
    const result = f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Provider unavailable");
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("blocked");
    expect(state.lastError).toContain("Provider unavailable");
    if (mode === "directory-lock")
      expect(result.stderr).toContain("Warning: could not remove run lock");
    else expect(result.stderr).not.toContain("ENOENT");
  },
  30_000,
);

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
  roots.push(dir);
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
  roots.push(dir);
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
  roots.push(dir);
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
    }),
    "utf8",
  );
  const settings = loadLoopSettings(join(dir, "loop-settings.json"));
  expect(settings.implement.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
  expect(settings.review.tools).toEqual(["read", "grep", "find", "ls"]);
});

it("leaves a replaced run lock for its new owner", () => {
  const f = fixture("replace-lock");
  const result = f.start();
  expect(result.status, result.stderr).toBe(0);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  expect(readFileSync(join(runDir, "run.lock"), "utf8")).toBe("new-owner\n");
  expect(result.stderr).toContain("replaced");
});

it("can resume a setup failure in the already-created worktree", () => {
  const f = fixture();
  const setup = `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('setup-ready')"`;
  const first = f.run(
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
  const runDir = first.stdout.match(/Run directory: (.+)/)![1];
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  writeFileSync(join(state.worktree, "setup-ready"), "ready");
  // Setup artifacts would normally be ignored dependency directories.
  writeFileSync(join(f.root, "ignore"), "setup-ready\n");
  f.git("config", "core.excludesFile", join(f.root, "ignore"));
  const resumed = f.run("resume", runDir);
  expect(resumed.status, resumed.stderr).toBe(0);
}, 30_000);
