import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = path.join(import.meta.dirname, "sync-upstream-skills.sh");
let fixture: string;
let consumer: string;

// Isolated from user and system config so fixture commits never depend on,
// or write to, anything outside the temporary repositories.
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Sync test",
  GIT_AUTHOR_EMAIL: "sync-test@example.invalid",
  GIT_COMMITTER_NAME: "Sync test",
  GIT_COMMITTER_EMAIL: "sync-test@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
}

function writeSkill(repo: string, name: string, body: string): void {
  const directory = path.join(repo, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), body);
}

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sync-test-"));
  const upstream = path.join(fixture, "upstream");
  consumer = path.join(fixture, "consumer");
  for (const repo of [upstream, consumer]) {
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
  }
  writeSkill(upstream, "skills/engineering/code-review", "upstream review\n");
  writeSkill(upstream, "skills/productivity/control", "upstream control\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "fixture upstream");
  writeSkill(consumer, "skills/code-review", "workspace review\n");
  writeSkill(consumer, "skills/matt-pocock/control", "old control\n");
  writeSkill(consumer, "skills/matt-pocock/dropped", "dropped skill\n");
  git(consumer, "add", ".");
  git(consumer, "commit", "-m", "fixture consumer");
  git(consumer, "remote", "add", "skills-upstream", upstream);
});

afterEach(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

function sync(...args: string[]): string {
  return execFileSync("bash", [script, ...args], {
    cwd: consumer,
    encoding: "utf8",
    env: { ...gitEnv, TMPDIR: fixture },
  });
}

function expectWorkspaceReview(): void {
  expect(fs.existsSync(path.join(consumer, "skills/matt-pocock/code-review"))).toBe(false);
  expect(fs.readFileSync(path.join(consumer, "skills/code-review/SKILL.md"), "utf8")).toBe(
    "workspace review\n",
  );
}

it("omits the retired review from proposals while reviewing other upstream changes", () => {
  sync();
  const output = path.join(consumer, ".scratch/skills-sync");
  const summary = fs.readFileSync(path.join(output, "SUMMARY.md"), "utf8");
  expect(summary).not.toContain("code-review");
  expect(summary).toContain("**control**");
  expect(fs.readdirSync(path.join(output, "diffs"))).toEqual(["control.diff"]);
  expectWorkspaceReview();
});

it("skips a named retired review while applying a non-excluded skill", () => {
  sync("--apply", "code-review");
  expectWorkspaceReview();
  sync("--apply", "control");
  expect(fs.readFileSync(path.join(consumer, "skills/matt-pocock/control/SKILL.md"), "utf8")).toBe(
    "upstream control\n",
  );
  expect(fs.existsSync(path.join(consumer, "skills/matt-pocock/dropped"))).toBe(true);
});

it("keeps the retired review absent during a full apply and removes dropped skills", () => {
  sync("--apply");
  expectWorkspaceReview();
  expect(fs.readFileSync(path.join(consumer, "skills/matt-pocock/control/SKILL.md"), "utf8")).toBe(
    "upstream control\n",
  );
  expect(fs.existsSync(path.join(consumer, "skills/matt-pocock/dropped"))).toBe(false);
});
