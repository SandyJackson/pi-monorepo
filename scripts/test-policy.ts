export const TEST_EXCLUDES = ["**/node_modules/**", "**/dist/**", "**/.scratch/**", "**/.git/**"];

export const SLOW_TEST_PATTERNS = [
  "packages/issue-loop/cli-*.test.ts",
  "**/*.integration.test.ts",
  "**/*.smoke.test.ts",
  "packages/herdr-subagent/delegated-task-startup.test.ts",
];

export interface WorkspacePackage {
  directory: string;
  name: string;
  dependencies: string[];
}

export interface TestPlan {
  scope: "fast" | "affected" | "all";
  affectedPackages: string[];
  integrationTests: string[];
  reason?: string;
}

function ordinaryDocumentation(path: string, directory?: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (!directory) return !path.includes("/") || path.startsWith("docs/");
  const relative = path.slice(directory.length + 1);
  return (
    relative.startsWith("docs/") || /^(README|CHANGELOG|CONTRIBUTING|LICENSE)\.md$/.test(relative)
  );
}

/** Fast tests always run; package integration follows the reverse workspace dependency graph. */
export function planAffectedTests(
  changedFiles: string[],
  packages: WorkspacePackage[],
  slowTests: string[],
): TestPlan {
  const affected = new Set<string>();
  for (const path of changedFiles) {
    const owner = packages.find((pkg) => path.startsWith(`${pkg.directory}/`));
    if (ordinaryDocumentation(path, owner?.directory)) continue;
    // Manifest changes can rename packages or remove dependency edges from this graph.
    if (owner && path !== `${owner.directory}/package.json`) {
      affected.add(owner.name);
      continue;
    }
    if (!path.includes("/") && path.endsWith(".test.ts")) continue;
    return {
      scope: "all",
      affectedPackages: packages.map((pkg) => pkg.directory).sort(),
      integrationTests: [...slowTests].sort(),
      reason: `Shared tooling, runtime resources or unclassified input: ${path}`,
    };
  }
  let added: boolean;
  do {
    added = false;
    for (const pkg of packages) {
      if (!affected.has(pkg.name) && pkg.dependencies.some((name) => affected.has(name))) {
        affected.add(pkg.name);
        added = true;
      }
    }
  } while (added);
  const affectedPackages = packages
    .filter((pkg) => affected.has(pkg.name))
    .map((pkg) => pkg.directory)
    .sort();
  const integrationTests = slowTests
    .filter((path) => affectedPackages.some((directory) => path.startsWith(`${directory}/`)))
    .sort();
  return {
    scope: integrationTests.length ? "affected" : "fast",
    affectedPackages,
    integrationTests,
  };
}
