import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PiResources {
  extensions: string[];
  skills: string[];
}

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  name: string;
  private: boolean;
  keywords: string[];
  engines: { node: string };
  pi: PiResources;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("Pi workspace package", () => {
  it("declares the workspace identity and Pi discovery keyword", () => {
    expect(manifest.name).toBe("pi-workspace");
    expect(manifest.private).toBe(true);
    expect(manifest.keywords).toContain("pi-package");
  });

  it("requires Node 22 or newer", () => {
    expect(manifest.engines.node).toBe(">=22");
  });

  it.each(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"])(
    "declares a non-empty development dependency for %s",
    (name) => {
      expect(manifest.devDependencies[name]).toEqual(expect.any(String));
      expect(manifest.devDependencies[name].trim()).not.toBe("");
    },
  );

  it.each([
    "@pi-workspace/herdr-contract",
    "@pi-workspace/herdr-subagent",
    "@pi-workspace/herdr-bridge",
    "@pi-workspace/session-auto-name",
    "@tmustier/pi-code-actions",
  ])("links %s through the workspace", (name) => {
    expect(manifest.dependencies[name]).toBe("workspace:*");
  });

  it("registers extensions that resolve to TypeScript entrypoints", () => {
    expect(manifest.pi.extensions.length).toBeGreaterThan(0);
    for (const entry of manifest.pi.extensions) {
      expect(entry).toMatch(/\.ts$/);
      expect(statSync(resolve(root, entry)).isFile(), entry).toBe(true);
    }
  });

  it("registers existing skill directories", () => {
    expect(manifest.pi.skills).toContain("./skills");
    for (const entry of manifest.pi.skills) {
      expect(statSync(resolve(root, entry)).isDirectory(), entry).toBe(true);
    }
  });
});
