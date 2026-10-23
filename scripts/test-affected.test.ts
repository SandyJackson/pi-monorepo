import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "test-affected.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(defaultBranch = true, dependencyField = "dependencies") {
  const root = mkdtempSync(join(tmpdir(), "affected-tests-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  for (const [directory, name, dependencies] of [
    ["issue-loop", "@test/loop", { "@test/agents": "workspace:*" }],
    ["herdr-subagent", "@test/agents", {}],
    ["session-auto-name", "@test/names", {}],
  ] as const) {
    write(
      `packages/${directory}/package.json`,
      JSON.stringify({ name, [dependencyField]: dependencies }),
    );
    write(`packages/${directory}/index.ts`, "export {};\n");
  }
  write("packages/issue-loop/cli-lifecycle.test.ts", "export {};\n");
  write("packages/issue-loop/process.integration.test.ts", "export {};\n");
  write("packages/herdr-subagent/delegated-task-startup.test.ts", "export {};\n");
  git("init", "--initial-branch=main");
  git("add", ".");
  git("commit", "-m", "Initial");
  const base = git("rev-parse", "HEAD");
  if (defaultBranch) {
    git("update-ref", "refs/remotes/origin/main", base);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  }
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "Change");
    return git("rev-parse", "HEAD");
  };
  const run = (args: string[] = [], input = "", list = true) => {
    try {
      return {
        status: 0,
        stdout: execFileSync(process.execPath, [script, ...(list ? ["--list"] : []), ...args], {
          cwd: root,
          env,
          encoding: "utf8",
          input,
          stdio: ["pipe", "pipe", "pipe"],
        }),
        stderr: "",
      };
    } catch (error) {
      const failure = error as Error & { status: number; stdout: string; stderr: string };
      return {
        status: failure.status,
        stdout: String(failure.stdout),
        stderr: String(failure.stderr),
      };
    }
  };
  const plan = (args: string[] = [], input = "") => {
    const result = run(args, input);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  return { root, base, env, git, write, commit, run, plan };
}

it("detects committed branch changes without selecting unrelated loop tests", () => {
  const f = fixture();
  f.git("switch", "-c", "work");
  f.write("packages/session-auto-name/index.ts", "export const changed = true;\n");
  f.commit();
  const plan = f.plan();
  expect(plan.changedFiles).toEqual(["packages/session-auto-name/index.ts"]);
  expect(plan.scope).toBe("fast");
  expect(plan.integrationTests).toEqual([]);
});

it("unions staged, unstaged and untracked changes", () => {
  const f = fixture();
  f.write("packages/issue-loop/index.ts", "export const staged = true;\n");
  f.git("add", "packages/issue-loop/index.ts");
  f.write("packages/session-auto-name/index.ts", "export const unstaged = true;\n");
  f.write("packages/issue-loop/agents/new.md", "Runtime role.\n");
  const plan = f.plan();
  expect(plan.changedFiles).toEqual([
    "packages/issue-loop/agents/new.md",
    "packages/issue-loop/index.ts",
    "packages/session-auto-name/index.ts",
  ]);
  expect(plan.integrationTests).toEqual([
    "packages/issue-loop/cli-lifecycle.test.ts",
    "packages/issue-loop/process.integration.test.ts",
  ]);
});

it("retains staged changes even when the working tree restores the original content", () => {
  const f = fixture();
  f.write("packages/issue-loop/index.ts", "export const staged = true;\n");
  f.git("add", "packages/issue-loop/index.ts");
  f.write("packages/issue-loop/index.ts", "export {};\n");
  expect(f.plan().scope).toBe("affected");
});

it("keeps a rename's old package path in the selection", () => {
  const f = fixture();
  mkdirSync(join(f.root, "docs"));
  renameSync(join(f.root, "packages/issue-loop/index.ts"), join(f.root, "docs/moved.md"));
  f.git("add", ".");
  const plan = f.plan();
  expect(plan.changedFiles).toContain("packages/issue-loop/index.ts");
  expect(plan.scope).toBe("affected");
});

it("selects consumers from workspace manifests", () => {
  const f = fixture();
  const path = "packages/herdr-subagent/index.ts";
  f.write(path, `${readFileSync(join(f.root, path), "utf8")}export const changed = true;\n`);
  const plan = f.plan();
  expect(plan.affectedPackages).toEqual(["packages/herdr-subagent", "packages/issue-loop"]);
  expect(plan.integrationTests).toContain("packages/issue-loop/cli-lifecycle.test.ts");
});

it("selects all tests for a deleted package whose ignored node_modules remain", () => {
  const f = fixture();
  writeFileSync(join(f.root, ".git/info/exclude"), "node_modules/\n");
  rmSync(join(f.root, "packages/session-auto-name"), { recursive: true });
  f.write("packages/session-auto-name/node_modules/dep/index.js", "module.exports = {};\n");
  const plan = f.plan();
  expect(plan.changedFiles).toEqual([
    "packages/session-auto-name/index.ts",
    "packages/session-auto-name/package.json",
  ]);
  expect(plan.scope).toBe("all");
  expect(plan.reason).toContain("packages/session-auto-name/");
});

it("selects all tests if the default comparison ref is unavailable", () => {
  const f = fixture(false);
  expect(f.plan().scope).toBe("all");
  expect(f.plan(["--base", f.base]).scope).toBe("fast");
});

it("fails clearly for an invalid explicit base", () => {
  const f = fixture();
  const result = f.run(["--base", "missing-branch"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("missing-branch");
});

it("uses the actual pushed range rather than rerunning earlier branch changes", () => {
  const f = fixture();
  f.write("packages/issue-loop/index.ts", "export const earlier = true;\n");
  const remote = f.commit();
  f.write("packages/session-auto-name/index.ts", "export const next = true;\n");
  const head = f.commit();
  const plan = f.plan(["--pre-push"], `refs/heads/work ${head} refs/heads/work ${remote}\n`);
  expect(plan.changedFiles).toEqual(["packages/session-auto-name/index.ts"]);
  expect(plan.scope).toBe("fast");
});

it("uses the default branch for a newly pushed branch", () => {
  const f = fixture();
  f.write("packages/issue-loop/index.ts", "export const changed = true;\n");
  const head = f.commit();
  const plan = f.plan(
    ["--pre-push"],
    `refs/heads/work ${head} refs/heads/work ${"0".repeat(40)}\n`,
  );
  expect(plan.scope).toBe("affected");
});

it("selects all tests if the old remote commit is unavailable locally", () => {
  const f = fixture();
  const plan = f.plan(
    ["--pre-push"],
    `refs/heads/main ${f.base} refs/heads/main ${"a".repeat(40)}\n`,
  );
  expect(plan.scope).toBe("all");
});

it("refuses to test a different checkout from the commit being pushed", () => {
  const f = fixture();
  f.write("packages/session-auto-name/index.ts", "export const changed = true;\n");
  f.commit();
  const result = f.run(
    ["--pre-push"],
    `refs/heads/other ${f.base} refs/heads/other ${"0".repeat(40)}\n`,
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("checkout");
});

it.each(["peerDependencies", "devDependencies", "optionalDependencies"])(
  "includes consumers declared through %s",
  (field) => {
    const f = fixture(true, field);
    f.write("packages/herdr-subagent/index.ts", "export const changed = true;\n");
    expect(f.plan().affectedPackages).toEqual(["packages/herdr-subagent", "packages/issue-loop"]);
  },
);

it("does not select branch changes when only a remote branch is deleted", () => {
  const f = fixture();
  f.write("packages/issue-loop/index.ts", "export const changed = true;\n");
  f.commit();
  expect(
    f.plan(["--pre-push"], `(delete) ${"0".repeat(40)} refs/heads/old ${f.base}\n`).scope,
  ).toBe("fast");
});

it("ignores pushed tags that do not point at the checkout", () => {
  const f = fixture();
  f.git("tag", "-a", "v1", "-m", "Release", f.base);
  const tag = f.git("rev-parse", "v1");
  f.write("packages/session-auto-name/index.ts", "export const changed = true;\n");
  f.commit();
  const plan = f.plan(["--pre-push"], `refs/tags/v1 ${tag} refs/tags/v1 ${"0".repeat(40)}\n`);
  expect(plan.scope).toBe("fast");
});

it("checks a branch pushed from a non-branch local ref", () => {
  const f = fixture();
  f.write("packages/issue-loop/index.ts", "export const changed = true;\n");
  const head = f.commit();
  const plan = f.plan(["--pre-push"], `HEAD ${head} refs/heads/work ${"0".repeat(40)}\n`);
  expect(plan.scope).toBe("affected");
});

it("refuses malformed pre-push input", () => {
  const f = fixture();
  const result = f.run(["--pre-push"], "not a git update\n");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Malformed pre-push");
});

it.each([false, true])("runs checks in order and propagates a failure: %s", (failTypecheck) => {
  const f = fixture();
  const bin = join(f.root, ".git", "test-bin");
  const log = join(f.root, ".git", "commands.jsonl");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (${failTypecheck} && args[0] === 'typecheck') process.exit(7);
`,
    { mode: 0o755 },
  );
  f.env.PATH = `${bin}:${process.env.PATH}`;
  const result = f.run(["--check"], "", false);
  expect(result.status, result.stderr).toBe(failTypecheck ? 7 : 0);
  const commands = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(commands).toEqual(
    failTypecheck ? [["lint"], ["typecheck"]] : [["lint"], ["typecheck"], ["test:fast"]],
  );
});
