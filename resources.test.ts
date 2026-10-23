import * as fs from "node:fs";
import * as path from "node:path";
import { loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseAgentFileContent } from "./packages/herdr-subagent/agents.ts";

const ROOT = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

it("ships prompt templates through the aggregate package", () => {
  expect(manifest.pi.prompts).toEqual(["./prompts"]);
});

it("resolves code-review to the workspace skill", () => {
  const { skills } = loadSkills({
    cwd: ROOT,
    skillPaths: manifest.pi.skills,
    includeDefaults: false,
  });
  expect(skills.find((skill) => skill.name === "code-review")?.filePath).toBe(
    path.join(ROOT, "skills/code-review/SKILL.md"),
  );
});

it("resolves web-research to the workspace skill", () => {
  const { skills } = loadSkills({
    cwd: ROOT,
    skillPaths: manifest.pi.skills,
    includeDefaults: false,
  });
  expect(skills.find((skill) => skill.name === "web-research")?.filePath).toBe(
    path.join(ROOT, "skills/web-research/SKILL.md"),
  );
});

function findSkillFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || !entry.isDirectory()) return [];
    const child = path.join(directory, entry.name);
    const skill = path.join(child, "SKILL.md");
    return [...(fs.existsSync(skill) ? [skill] : []), ...findSkillFiles(child)];
  });
}

const skills = findSkillFiles(path.join(ROOT, "skills"));
const promptsDirectory = path.join(ROOT, "prompts");
const prompts = fs.existsSync(promptsDirectory)
  ? fs
      .readdirSync(promptsDirectory)
      .filter((name) => !name.startsWith(".") && name.endsWith(".md"))
      .map((name) => path.join(promptsDirectory, name))
  : [];
const agents = fs
  .readdirSync(path.join(ROOT, "agents"))
  .filter((name) => !name.startsWith(".") && name.endsWith(".md"))
  .map((name) => path.join(ROOT, "agents", name));

describe("agent tool provisioning", () => {
  it.each(agents.map((file) => path.relative(ROOT, file)))(
    "%s enables codemode and the intended search tools",
    (file) => {
      const content = fs.readFileSync(path.join(ROOT, file), "utf8");
      const agent = parseAgentFileContent(content, path.basename(file, ".md"));
      expect(agent.tools).toContain("codemode");
      expect(content).not.toMatch(/pi-web-access|web_search|fetch_content|get_search_content/);
      const searchTools = agent.tools?.filter((tool) => tool.startsWith("ketch_"));
      expect(searchTools).toEqual(
        ["docs-researcher", "explain", "implement", "code-reviewer"].includes(agent.name)
          ? ["ketch_search", "ketch_code", "ketch_docs", "ketch_scrape"]
          : [],
      );
    },
  );
});

for (const [kind, files] of [
  ["Skills", skills],
  ["Agents", agents],
  ["Prompt templates", prompts],
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
