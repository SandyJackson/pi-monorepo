/**
 * Resource inventory tests for workspace skills and agents.
 *
 * These tests ensure that all expected skills and agents are present,
 * properly formatted, and contain required fields.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = import.meta.dirname;

// ---------------------------------------------------------------------------
// Expected resource inventories
// ---------------------------------------------------------------------------

/** All 23 skills that must exist in the workspace. */
const EXPECTED_SKILLS = [
  "ask-matt",
  "code-review",
  "codebase-design",
  "deslop",
  "diagnosing-bugs",
  "domain-modeling",
  "git-rebase",
  "great-tables",
  "grill-me",
  "grill-with-docs",
  "grilling",
  "handoff",
  "implement",
  "improve-codebase-architecture",
  "prototype",
  "research",
  "resolving-merge-conflicts",
  "setup-matt-pocock-skills",
  "tdd",
  "to-spec",
  "to-tickets",
  "triage",
  "wayfinder",
];

/** All 5 agents that must exist in the workspace. */
const EXPECTED_AGENTS = [
  "code-reviewer",
  "codebase-analyser",
  "docs-researcher",
  "explain",
  "refactor",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function readMarkdown(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  
  const fm: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    
    const key = line.slice(0, colonIdx).trim();
    let value: string | string[] = line.slice(colonIdx + 1).trim();
    
    // Handle arrays like [bash-permission]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim());
    }
    
    fm[key] = value;
  }
  
  return fm;
}

function getSkillDir(name: string): string {
  return path.join(ROOT, "skills", name);
}

function getSkillFile(name: string): string {
  return path.join(ROOT, "skills", name, "SKILL.md");
}

function getAgentFile(name: string): string {
  return path.join(ROOT, "agents", `${name}.md`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Skills inventory", () => {
  it("all expected skills are present", () => {
    const skillsDir = path.join(ROOT, "skills");
    expect(exists(skillsDir)).toBe(true);
    
    const actual = fs.readdirSync(skillsDir);
    for (const expected of EXPECTED_SKILLS) {
      expect(actual).toContain(expected);
    }
  });

  it("no unexpected skill directories exist", () => {
    const skillsDir = path.join(ROOT, "skills");
    const actual = fs.readdirSync(skillsDir).filter((entry) => {
      const fullPath = path.join(skillsDir, entry);
      return fs.statSync(fullPath).isDirectory() && entry !== "scripts";
    });
    for (const skill of actual) {
      expect(EXPECTED_SKILLS).toContain(skill);
    }
  });

  for (const skill of EXPECTED_SKILLS) {
    it(`${skill} has SKILL.md`, () => {
      const skillFile = getSkillFile(skill);
      expect(exists(skillFile)).toBe(true);
      
      const content = readMarkdown(skillFile);
      expect(content.length).toBeGreaterThan(0);
    });

    it(`${skill} has valid frontmatter with description`, () => {
      const skillFile = getSkillFile(skill);
      const content = readMarkdown(skillFile);
      const fm = parseFrontmatter(content);
      
      expect(fm.description).toBeDefined();
      expect(typeof fm.description).toBe("string");
      expect((fm.description as string).length).toBeGreaterThan(0);
    });
  }
});

describe("Agents inventory", () => {
  it("all expected agents are present", () => {
    const agentsDir = path.join(ROOT, "agents");
    expect(exists(agentsDir)).toBe(true);
    
    const actual = fs.readdirSync(agentsDir);
    for (const expected of EXPECTED_AGENTS) {
      expect(actual).toContain(`${expected}.md`);
    }
  });

  it("no unexpected agents exist", () => {
    const agentsDir = path.join(ROOT, "agents");
    const actual = fs.readdirSync(agentsDir);
    for (const agent of actual) {
      const name = agent.replace(".md", "");
      expect(EXPECTED_AGENTS).toContain(name);
    }
  });

  for (const agent of EXPECTED_AGENTS) {
    it(`${agent} has markdown file`, () => {
      const agentFile = getAgentFile(agent);
      expect(exists(agentFile)).toBe(true);
      
      const content = readMarkdown(agentFile);
      expect(content.length).toBeGreaterThan(0);
    });

    it(`${agent} has valid frontmatter with description`, () => {
      const agentFile = getAgentFile(agent);
      const content = readMarkdown(agentFile);
      const fm = parseFrontmatter(content);
      
      expect(fm.description).toBeDefined();
      expect(typeof fm.description).toBe("string");
      expect((fm.description as string).length).toBeGreaterThan(0);
    });

    it(`${agent} has system prompt body`, () => {
      const agentFile = getAgentFile(agent);
      const content = readMarkdown(agentFile);
      
      // Content after frontmatter
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
      expect(body.length).toBeGreaterThan(0);
    });
  }
});

describe("Bash policy documentation", () => {
  it("bash-policy.md exists", () => {
    const policyFile = path.join(ROOT, "docs", "bash-policy.md");
    expect(exists(policyFile)).toBe(true);
  });

  it("bash-policy.md has content", () => {
    const policyFile = path.join(ROOT, "docs", "bash-policy.md");
    const content = readMarkdown(policyFile);
    expect(content.length).toBeGreaterThan(100);
  });
});

describe("Agent discovery documentation", () => {
  it("agent-discovery.md exists", () => {
    const docFile = path.join(ROOT, "docs", "agent-discovery.md");
    expect(exists(docFile)).toBe(true);
  });

  it("agent-discovery.md has content", () => {
    const docFile = path.join(ROOT, "docs", "agent-discovery.md");
    const content = readMarkdown(docFile);
    expect(content.length).toBeGreaterThan(100);
  });
});
