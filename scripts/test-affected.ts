import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { withIntegrationLock } from "./integration-lock.ts";
import {
  planAffectedTests,
  SLOW_TEST_PATTERNS,
  TEST_EXCLUDES,
  type WorkspacePackage,
} from "./test-policy.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function workspacePackages(root: string): WorkspacePackage[] {
  return (
    readdirSync(join(root, "packages"), { withFileTypes: true })
      // A removed package can leave ignored files such as node_modules/ behind;
      // its changed paths then have no owner and select the full suite.
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")),
      )
      .map((entry) => {
        const directory = `packages/${entry.name}`;
        const manifest = JSON.parse(
          readFileSync(join(root, directory, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        if (typeof manifest.name !== "string")
          throw new Error(`Missing package name in ${directory}/package.json`);
        const dependencies = [
          "dependencies",
          "peerDependencies",
          "devDependencies",
          "optionalDependencies",
        ].flatMap((field) => {
          const value = manifest[field];
          if (value === undefined) return [];
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error(`Invalid ${field} in ${directory}/package.json`);
          return Object.keys(value);
        });
        return { directory, name: manifest.name, dependencies };
      })
  );
}

function changes(root: string, explicitBase: string | undefined, pushInput: string | undefined) {
  const names = (output: string) => output.split("\0").filter(Boolean);
  const diff = (...refs: string[]) =>
    names(git(root, "diff", "--name-only", "--no-renames", "-z", ...refs, "--"));
  const files = new Set([
    ...diff("--cached", "HEAD"),
    ...diff(),
    ...names(git(root, "ls-files", "--others", "--exclude-standard", "-z")),
  ]);
  let reason: string | undefined;
  const branchChanges = () => {
    try {
      const base = explicitBase ?? "refs/remotes/origin/HEAD";
      const resolvedBase = git(
        root,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${base}^{commit}`,
      ).trim();
      const ancestor = git(root, "merge-base", "HEAD", resolvedBase).trim();
      return diff(ancestor, "HEAD");
    } catch (error) {
      if (explicitBase)
        throw new Error(
          `Cannot compare base ${explicitBase}: ${error instanceof Error ? error.message : String(error)}`,
        );
      reason = "Default comparison ref is unavailable; selecting the full suite";
      return [];
    }
  };
  if (pushInput?.trim()) {
    const head = git(root, "rev-parse", "HEAD").trim();
    for (const line of pushInput.trim().split("\n")) {
      const fields = line.trim().split(/\s+/);
      const [, local, remoteRef, remote] = fields;
      if (
        fields.length !== 4 ||
        ![local, remote].every((oid) => /^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(oid))
      )
        throw new Error("Malformed pre-push ref update");
      // Only branch updates carry code to check; tags may point at any commit.
      // The local ref can be HEAD or a commit, so classify by the remote ref.
      if (/^0+$/.test(local) || !remoteRef.startsWith("refs/heads/")) continue;
      const commit = git(root, "rev-parse", "--verify", `${local}^{commit}`).trim();
      if (commit !== head)
        throw new Error(
          "Push checks require the checkout to match the commit being pushed; check out that branch before pushing",
        );
      if (/^0+$/.test(remote)) {
        for (const path of branchChanges()) files.add(path);
      } else {
        try {
          for (const path of diff(remote, commit)) files.add(path);
        } catch {
          reason = "Old remote commit is unavailable locally; selecting the full suite";
        }
      }
    }
  } else {
    for (const path of branchChanges()) files.add(path);
  }
  return { changedFiles: [...files].sort(), reason };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      list: { type: "boolean" },
      check: { type: "boolean" },
      "pre-push": { type: "boolean" },
    },
  });
  // Read Git's ref updates before child commands can consume stdin.
  const pushInput = values["pre-push"] ? readFileSync(0, "utf8") : undefined;
  const root = git(process.cwd(), "rev-parse", "--show-toplevel").trim();
  const packages = workspacePackages(root);
  const slowTests = [
    ...new Set(globSync(SLOW_TEST_PATTERNS, { cwd: root, exclude: TEST_EXCLUDES })),
  ].sort();
  const detected = changes(root, values.base, pushInput);
  let plan = planAffectedTests(detected.changedFiles, packages, slowTests);
  if (detected.reason) {
    plan = {
      scope: "all",
      affectedPackages: packages.map((pkg) => pkg.directory).sort(),
      integrationTests: slowTests,
      reason: detected.reason,
    };
  }
  const commands: string[][] = values.check ? [["lint"], ["typecheck"]] : [];
  commands.push(["test:fast"]);
  if (plan.integrationTests.length)
    commands.push(["exec", "vitest", "run", ...plan.integrationTests]);
  if (values.list) {
    console.log(
      JSON.stringify({ ...plan, changedFiles: detected.changedFiles, commands }, null, 2),
    );
    return;
  }
  console.log(`Test scope: ${plan.scope}${plan.reason ? ` (${plan.reason})` : ""}`);
  if (plan.affectedPackages.length)
    console.log(`Affected packages: ${plan.affectedPackages.join(", ")}`);
  for (const args of commands) {
    console.log(`\n> pnpm ${args.join(" ")}`);
    const run = () => spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
    const child = args[0] === "exec" ? withIntegrationLock("pnpm check:affected", run) : run();
    if (child.error) throw child.error;
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
