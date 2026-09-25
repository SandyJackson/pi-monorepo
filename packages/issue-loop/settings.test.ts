import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_IMPLEMENT_TOOLS,
  DEFAULT_REVIEW_TOOLS,
  loadLoopSettings,
  materializeLoopSkills,
  validateLoopSkills,
} from "./settings.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeSettingsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-settings-test-"));
  roots.push(dir);
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  return path.join(dir, "loop-settings.json");
}

const implementAgent = `---
description: Loop implementer
model: provider/implement-model
tools: read, grep, find, ls, bash, edit, write
---

Implement the ticket.`;

const reviewAgent = `---
description: Loop reviewer
model: provider/review-model
tools: read, grep, find, ls
---

Review the patch.`;

describe("loadLoopSettings", () => {
  it("resolves agent files relative to the settings file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-settings-test-"));
    roots.push(dir);
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "loop-settings.json"),
      JSON.stringify({
        implementAgent: "./agents/implement.md",
        reviewAgent: "./agents/review.md",
        appendSystemPrompt: "Prefer small changes.",
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "agents", "implement.md"), implementAgent, "utf8");
    fs.writeFileSync(path.join(dir, "agents", "review.md"), reviewAgent, "utf8");
    const settingsPath = path.join(dir, "loop-settings.json");
    const settings = loadLoopSettings(settingsPath);
    expect(settings).toEqual({
      implement: {
        agentName: "implement",
        model: "provider/implement-model",
        tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
        skills: ["tdd", "diagnosing-bugs", "deslop"],
        promptBody: "Implement the ticket.",
      },
      review: {
        agentName: "review",
        model: "provider/review-model",
        tools: ["read", "grep", "find", "ls"],
        skills: [],
        promptBody: "Review the patch.",
      },
      appendSystemPrompt: "Prefer small changes.",
    });
  });

  it("falls back to loop defaults when no agents are configured", () => {
    const settingsPath = writeSettingsDir({ "loop-settings.json": "{}" });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.implement).toEqual({
      agentName: "loop-implement",
      model: undefined,
      tools: DEFAULT_IMPLEMENT_TOOLS,
      skills: ["tdd", "diagnosing-bugs", "deslop"],
      promptBody: expect.stringContaining("/skill:tdd"),
    });
    expect(settings.review).toEqual({
      agentName: "loop-reviewer",
      model: undefined,
      tools: DEFAULT_REVIEW_TOOLS,
      skills: [],
      promptBody: expect.stringContaining("[Spec]"),
    });
    expect(settings.appendSystemPrompt).toBeUndefined();
  });

  it("ignores unknown top-level keys", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementModel: "provider/x" }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.appendSystemPrompt).toBeUndefined();
  });

  it("parses per-role skill short names", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({
        implementSkills: ["tdd"],
        reviewSkills: [],
      }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.implement.skills).toEqual(["tdd"]);
    expect(settings.review.skills).toEqual([]);
  });

  it.each([
    ["not-an-array", "implementSkills"],
    [["ok", 42], "implementSkills"],
    [["Has-Caps"], "implementSkills"],
    [["has space"], "reviewSkills"],
    [[""], "reviewSkills"],
    [["tdd", "tdd"], "implementSkills"],
    [["-tdd"], "implementSkills"],
    [["tdd-"], "reviewSkills"],
    [["test--skill"], "implementSkills"],
  ])("rejects invalid skill lists (%j)", (value, field) => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ [field as string]: value }),
    });
    expect(() => loadLoopSettings(settingsPath)).toThrow(/implementSkills|reviewSkills/);
  });

  it("validates skills against the curated dir and materializes them into the run dir", () => {
    const curated = fs.mkdtempSync(path.join(os.tmpdir(), "loop-curated-test-"));
    roots.push(curated);
    fs.mkdirSync(path.join(curated, "tdd"), { recursive: true });
    fs.writeFileSync(path.join(curated, "tdd", "SKILL.md"), "# tdd\n", "utf8");
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementSkills: ["tdd"] }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(() => validateLoopSkills(settings, curated)).not.toThrow();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-run-test-"));
    roots.push(runDir);
    materializeLoopSkills(settings, runDir, curated);
    expect(fs.readFileSync(path.join(runDir, "skills", "tdd", "SKILL.md"), "utf8")).toBe("# tdd\n");
  });

  it("rejects unknown skills against the curated dir", () => {
    const curated = fs.mkdtempSync(path.join(os.tmpdir(), "loop-curated-test-"));
    roots.push(curated);
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementSkills: ["nope"] }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(() => validateLoopSkills(settings, curated)).toThrow(/Unknown loop skill "nope"/);
  });

  it("loads the blessed loop agent files with read-only review tools", () => {
    const pkgDir = path.resolve(import.meta.dirname);
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({
        implementAgent: path.join(pkgDir, "agents", "loop-implement.md"),
        reviewAgent: path.join(pkgDir, "agents", "loop-reviewer.md"),
        implementSkills: ["tdd", "diagnosing-bugs", "deslop"],
      }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.implement.agentName).toBe("loop-implement");
    expect(settings.implement.model).toBeUndefined();
    expect(settings.implement.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
    ]);
    expect(settings.implement.skills).toEqual(["tdd", "diagnosing-bugs", "deslop"]);
    expect(settings.implement.promptBody).toContain("/skill:tdd");
    expect(settings.review.agentName).toBe("loop-reviewer");
    expect(settings.review.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(settings.review.skills).toEqual([]);
    expect(settings.review.promptBody).toContain("Spec");
    expect(() => validateLoopSkills(settings)).not.toThrow();
  });

  it("rejects a review agent that requests mutating tools", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ reviewAgent: "./review.md" }),
      "review.md": `---\ndescription: Rogue reviewer\ntools: read, edit\n---\n\nReview.`,
    });
    expect(() => loadLoopSettings(settingsPath)).toThrow(/read-only/i);
  });

  it("rejects an agent file with an empty prompt body", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementAgent: "./implement.md" }),
      "implement.md": `---\ndescription: Empty\nmodel: provider/x\n---\n`,
    });
    expect(() => loadLoopSettings(settingsPath)).toThrow(/empty/i);
  });

  it("resolves per-role thinking levels from agent frontmatter", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({
        implementAgent: "./implement.md",
        reviewAgent: "./review.md",
      }),
      "implement.md": `---\ndescription: Thinker\nmodel: provider/x\nthinking: high\n---\n\nImplement.`,
      "review.md": `---\ndescription: Skimmer\nthinking: low\n---\n\nReview.`,
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.implement.thinking).toBe("high");
    expect(settings.review.thinking).toBe("low");
  });

  it("leaves thinking undefined when the frontmatter omits it", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementAgent: "./implement.md" }),
      "implement.md": `---\ndescription: Plain\nmodel: provider/x\n---\n\nImplement.`,
    });
    expect(loadLoopSettings(settingsPath).implement.thinking).toBeUndefined();
  });

  it('rejects an unknown thinking level ("ultra")', () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementAgent: "./implement.md" }),
      "implement.md": `---\ndescription: Thinker\nthinking: ultra\n---\n\nImplement.`,
    });
    expect(() => loadLoopSettings(settingsPath)).toThrow(/thinking.*ultra/i);
  });
});
