import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Pi workspace package", () => {
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf-8"));

  it("has required pi package fields", () => {
    expect(packageJson.name).toBe("pi-workspace");
    expect(packageJson.private).toBe(true);
    expect(packageJson.keywords).toContain("pi-package");
  });

  it("declares pi extensions", () => {
    expect(packageJson.pi?.extensions).toBeDefined();
    expect(packageJson.pi?.extensions.length).toBeGreaterThan(0);
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

  it("has workspace dependencies for extension packages", () => {
    expect(packageJson.dependencies?.["@pi-workspace/herdr-contract"]).toBeDefined();
    expect(packageJson.dependencies?.["@pi-workspace/bash-permission"]).toBeDefined();
    expect(packageJson.dependencies?.["@pi-workspace/herdr-subagent"]).toBeDefined();
    expect(packageJson.dependencies?.["@pi-workspace/herdr-bridge"]).toBeDefined();
    expect(packageJson.dependencies?.["@pi-workspace/session-auto-name"]).toBeDefined();
  });
});
