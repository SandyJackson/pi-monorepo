/**
 * Resource inventory tests for workspace skills and agents.
 *
 * Skills and agents are discovered from disk rather than hardcoded, so adding
 * or removing one does not break the suite. Each discovered resource is
 * checked for shape: present, non-empty, with a description and (for agents)
 * a prompt body.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter as piParseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const ROOT = import.meta.dirname;

// ---------------------------------------------------------------------------
// Resource discovery
// ---------------------------------------------------------------------------

/**
 * Every SKILL.md under skills/, including nested vendor directories such as
 * skills/matt-pocock/. Directories without a SKILL.md (e.g. skills/scripts/)
 * are not skills and are skipped.
 */
function findSkillFiles(): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      if (exists(path.join(full, "SKILL.md"))) {
        out.push(path.join(full, "SKILL.md"));
      }
      visit(full);
    }
  };
  visit(path.join(ROOT, "skills"));
  return out;
}

/** Every agent definition in agents/. */
function findAgentFiles(): string[] {
  const dir = path.join(ROOT, "agents");
  return fs
    .readdirSync(dir)
    .filter((entry) => !entry.startsWith(".") && entry.endsWith(".md"))
    .map((entry) => path.join(dir, entry));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function readMarkdown(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

/**
 * Parse with Pi's own frontmatter parser, so the suite fails on anything Pi
 * would choke on at runtime (bad indentation, tabs, duplicate keys). A YAML
 * syntax error throws, failing the test.
 */
function parseResource(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  return piParseFrontmatter<Record<string, unknown>>(content);
}

function displayName(file: string): string {
  return path.relative(ROOT, file);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Skills inventory", () => {
  const skillFiles = findSkillFiles();

  it("discovers at least one skill", () => {
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  for (const skillFile of skillFiles) {
    it(`${displayName(skillFile)} is non-empty`, () => {
      expect(readMarkdown(skillFile).length).toBeGreaterThan(0);
    });

    it(`${displayName(skillFile)} has valid frontmatter with description`, () => {
      const fm = parseResource(readMarkdown(skillFile)).frontmatter;

      expect(fm.description).toBeDefined();
      expect(typeof fm.description).toBe("string");
      expect((fm.description as string).length).toBeGreaterThan(0);
    });
  }
});

describe("Agents inventory", () => {
  const agentFiles = findAgentFiles();

  it("discovers at least one agent", () => {
    expect(agentFiles.length).toBeGreaterThan(0);
  });

  for (const agentFile of agentFiles) {
    it(`${displayName(agentFile)} is non-empty`, () => {
      expect(readMarkdown(agentFile).length).toBeGreaterThan(0);
    });

    it(`${displayName(agentFile)} has valid frontmatter with description`, () => {
      const fm = parseResource(readMarkdown(agentFile)).frontmatter;

      expect(fm.description).toBeDefined();
      expect(typeof fm.description).toBe("string");
      expect((fm.description as string).length).toBeGreaterThan(0);
    });

    it(`${displayName(agentFile)} has system prompt body`, () => {
      const { body } = parseResource(readMarkdown(agentFile));
      expect(body.trim().length).toBeGreaterThan(0);
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
