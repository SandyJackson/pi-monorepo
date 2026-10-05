import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const ROOT = import.meta.dirname;

function findSkillFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || !entry.isDirectory()) return [];
    const child = path.join(directory, entry.name);
    const skill = path.join(child, "SKILL.md");
    return [...(fs.existsSync(skill) ? [skill] : []), ...findSkillFiles(child)];
  });
}

const skills = findSkillFiles(path.join(ROOT, "skills"));
const agents = fs
  .readdirSync(path.join(ROOT, "agents"))
  .filter((name) => !name.startsWith(".") && name.endsWith(".md"))
  .map((name) => path.join(ROOT, "agents", name));

for (const [kind, files] of [
  ["Skills", skills],
  ["Agents", agents],
] as const) {
  describe(`${kind} inventory`, () => {
    it("discovers resources", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files.map((file) => path.relative(ROOT, file)))("%s is usable by Pi", (file) => {
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
      );
      expect(frontmatter.description).toEqual(expect.any(String));
      expect((frontmatter.description as string).trim()).not.toBe("");
      expect(body.trim()).not.toBe("");
    });
  });
}
