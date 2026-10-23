import { describe, expect, it } from "vitest";
import { planAffectedTests, type WorkspacePackage } from "./test-policy.ts";

const packages: WorkspacePackage[] = [
  { directory: "packages/issue-loop", name: "@test/loop", dependencies: ["@test/agents"] },
  { directory: "packages/herdr-subagent", name: "@test/agents", dependencies: ["@test/contract"] },
  { directory: "packages/herdr-contract", name: "@test/contract", dependencies: [] },
  { directory: "packages/session-auto-name", name: "@test/names", dependencies: [] },
];
const slowTests = [
  "packages/issue-loop/cli-lifecycle.test.ts",
  "packages/issue-loop/process.integration.test.ts",
  "packages/herdr-subagent/delegated-task-startup.test.ts",
  "packages/herdr-subagent/herdr/tab-create.smoke.test.ts",
];

describe("affected test policy", () => {
  it.each([
    { paths: [] },
    { paths: ["README.md", "AGENTS.md", "docs/agents/testing.md"] },
    { paths: ["packages/issue-loop/README.md"] },
    { paths: ["resources.test.ts"] },
  ])("keeps ordinary documentation and root fast tests in the fast suite: $paths", ({ paths }) => {
    expect(planAffectedTests(paths, packages, slowTests).scope).toBe("fast");
    expect(planAffectedTests(paths, packages, slowTests).integrationTests).toEqual([]);
  });

  it("does not select issue-loop for an unrelated extension", () => {
    const plan = planAffectedTests(["packages/session-auto-name/index.ts"], packages, slowTests);
    expect(plan.scope).toBe("fast");
    expect(plan.affectedPackages).toEqual(["packages/session-auto-name"]);
    expect(plan.integrationTests).toEqual([]);
  });

  it.each([
    "packages/issue-loop/runner.ts",
    "packages/issue-loop/agents/loop-implement.md",
    "packages/issue-loop/loop-skills/tdd/SKILL.md",
    "packages/issue-loop/test-fixtures/fake-pi.cjs",
    "packages/issue-loop/cli-repair.test.ts",
  ])("selects loop integration for runtime inputs: %s", (path) => {
    const plan = planAffectedTests([path], packages, slowTests);
    expect(plan.scope).toBe("affected");
    expect(plan.integrationTests).toEqual([
      "packages/issue-loop/cli-lifecycle.test.ts",
      "packages/issue-loop/process.integration.test.ts",
    ]);
  });

  it("includes consumers of a shared agent parser", () => {
    const plan = planAffectedTests(["packages/herdr-subagent/agents.ts"], packages, slowTests);
    expect(plan.affectedPackages).toEqual(["packages/herdr-subagent", "packages/issue-loop"]);
    expect(plan.integrationTests).toEqual([...slowTests].sort());
  });

  it("follows transitive workspace dependencies", () => {
    const plan = planAffectedTests(["packages/herdr-contract/index.ts"], packages, slowTests);
    expect(plan.affectedPackages).toEqual([
      "packages/herdr-contract",
      "packages/herdr-subagent",
      "packages/issue-loop",
    ]);
    expect(plan.integrationTests).toEqual([...slowTests].sort());
  });

  it.each([
    "package.json",
    "packages/issue-loop/package.json",
    "pnpm-lock.yaml",
    "vitest.config.ts",
    "tsconfig.json",
    "lefthook.yml",
    "scripts/test-affected.ts",
    "agents/implement.md",
    "skills/tdd/SKILL.md",
    "prompts/review.md",
    "unknown/input.json",
    "packages/deleted-package/index.ts",
  ])("falls back to the full suite for shared or unknown inputs: %s", (path) => {
    const plan = planAffectedTests([path], packages, slowTests);
    expect(plan.scope).toBe("all");
    expect(plan.integrationTests).toEqual([...slowTests].sort());
    expect(plan.reason).toContain(path);
  });
});
