import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Pi workspace package", () => {
  const packageJson = JSON.parse(
    readFileSync(join(import.meta.dirname, "package.json"), "utf-8")
  );

  it("has required pi package fields", () => {
    expect(packageJson.name).toBe("pi-workspace");
    expect(packageJson.private).toBe(true);
    expect(packageJson.keywords).toContain("pi-package");
  });

  it("declares pi extensions path", () => {
    expect(packageJson.pi?.extensions).toBeDefined();
    expect(packageJson.pi?.extensions).toContain("./extensions");
  });

  it("declares pi skills path", () => {
    expect(packageJson.pi?.skills).toBeDefined();
    expect(packageJson.pi?.skills).toContain("./skills");
  });

  it("requires Node 22+", () => {
    expect(packageJson.engines?.node).toBe(">=22");
  });

  it("has Pi core packages as devDependencies", () => {
    expect(packageJson.devDependencies?.["@earendil-works/pi-coding-agent"]).toBeDefined();
    expect(packageJson.devDependencies?.["@earendil-works/pi-ai"]).toBeDefined();
    expect(packageJson.devDependencies?.["@earendil-works/pi-tui"]).toBeDefined();
  });
});
