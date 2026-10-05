import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface PiResources {
  extensions: string[];
  skills: string[];
}

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  pi: PiResources;
};

describe("Pi workspace resource registration", () => {
  it("registers extensions that resolve to TypeScript entrypoints", () => {
    expect(manifest.pi.extensions.length).toBeGreaterThan(0);
    for (const entry of manifest.pi.extensions) {
      expect(entry).toMatch(/\.ts$/);
      expect(statSync(resolve(root, entry)).isFile(), entry).toBe(true);
    }
  });

  it("registers existing skill directories", () => {
    expect(manifest.pi.skills.length).toBeGreaterThan(0);
    for (const entry of manifest.pi.skills) {
      expect(statSync(resolve(root, entry)).isDirectory(), entry).toBe(true);
    }
  });
});
