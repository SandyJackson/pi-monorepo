import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEADLINES,
  DEFAULT_IMPLEMENT_TOOLS,
  DEFAULT_RECOVERY,
  DEFAULT_REPAIR_ROUNDS,
  DEFAULT_REVIEW_TOOLS,
  DEFAULT_WATCHDOG,
  DESCRIBE_TOOLS,
  defaultLoopSettings,
  loadLoopSettings,
  materializeLoopSkills,
  validateLoopSkills,
} from "./settings.js";
import { installDefaultExtensions } from "./test-fixtures/extensions.ts";

const roots: string[] = [];
let agentDir: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-agent-test-"));
  roots.push(agentDir);
  installDefaultExtensions(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      extensions: [
        { path: path.join(agentDir, "npm", "node_modules", "pi-claude-bridge"), version: "1.2.3" },
        { path: path.join(agentDir, "npm", "node_modules", "pi-web-access"), version: "1.2.3" },
      ],
      implement: {
        agentName: "implement",
        model: "provider/implement-model",
        thinking: undefined,
        tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
        skills: ["tdd", "diagnosing-bugs", "deslop"],
        promptBody: "Implement the ticket.",
      },
      repair: {
        agentName: "loop-repair",
        model: undefined,
        thinking: undefined,
        tools: DEFAULT_IMPLEMENT_TOOLS,
        skills: ["tdd", "diagnosing-bugs", "deslop"],
        promptBody: expect.stringContaining("Repair the findings"),
      },
      review: {
        agentName: "review",
        model: "provider/review-model",
        thinking: undefined,
        tools: ["read", "grep", "find", "ls"],
        skills: [],
        promptBody: "Review the patch.",
      },
      describe: {
        agentName: "loop-pr",
        model: undefined,
        thinking: undefined,
        tools: DESCRIBE_TOOLS,
        skills: ["pr"],
        promptBody: expect.stringContaining("/skill:pr"),
      },
      repairRounds: DEFAULT_REPAIR_ROUNDS,
      watchdog: DEFAULT_WATCHDOG,
      recovery: DEFAULT_RECOVERY,
      deadlines: DEFAULT_DEADLINES,
      appendSystemPrompt: "Prefer small changes.",
    });
  });

  it("falls back to loop defaults when no agents are configured", () => {
    const settingsPath = writeSettingsDir({ "loop-settings.json": "{}" });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.implement).toEqual({
      agentName: "loop-implement",
      model: "claude-bridge/claude-opus-5-5",
      thinking: "medium",
      tools: [...DEFAULT_IMPLEMENT_TOOLS, "web_search", "fetch_content", "get_search_content"],
      skills: ["tdd", "diagnosing-bugs", "deslop"],
      promptBody: expect.stringContaining("/skill:tdd"),
    });
    expect(settings.review).toEqual({
      agentName: "loop-reviewer",
      model: "openai-codex/gpt-6.1-sol",
      thinking: "high",
      tools: DEFAULT_REVIEW_TOOLS,
      skills: [],
      promptBody: expect.stringContaining("## Flag gate"),
    });
    expect(settings.repair).toEqual({
      agentName: "loop-repair",
      model: undefined,
      thinking: undefined,
      tools: DEFAULT_IMPLEMENT_TOOLS,
      skills: ["tdd", "diagnosing-bugs", "deslop"],
      promptBody: expect.stringContaining("Repair the findings"),
    });
    expect(settings.repairRounds).toBe(DEFAULT_REPAIR_ROUNDS);
    expect(settings.watchdog).toEqual(DEFAULT_WATCHDOG);
    expect(settings.recovery).toEqual(DEFAULT_RECOVERY);
    expect(settings.deadlines).toEqual(DEFAULT_DEADLINES);
    expect(settings.appendSystemPrompt).toBeUndefined();
  });

  it("ignores unknown top-level keys", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementModel: "provider/x" }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.appendSystemPrompt).toBeUndefined();
  });

  it("loads installed bridge and web packages from PI_CODING_AGENT_DIR by default", () => {
    const expected = [
      { path: path.join(agentDir, "npm", "node_modules", "pi-claude-bridge"), version: "1.2.3" },
      { path: path.join(agentDir, "npm", "node_modules", "pi-web-access"), version: "1.2.3" },
    ];
    expect(defaultLoopSettings().extensions).toEqual(expected);
    const settingsPath = writeSettingsDir({ "loop-settings.json": "{}" });
    expect(loadLoopSettings(settingsPath).extensions).toEqual(expected);
  });

  it("allows an explicit empty list to disable default extensions", () => {
    fs.rmSync(path.join(agentDir, "npm"), { recursive: true });
    const settingsPath = writeSettingsDir({ "loop-settings.json": '{"extensions":[]}' });
    expect(loadLoopSettings(settingsPath).extensions).toEqual([]);
  });

  it("reports a missing default package without silently dropping it", () => {
    fs.rmSync(path.join(agentDir, "npm", "node_modules", "pi-web-access"), { recursive: true });
    expect(() => defaultLoopSettings()).toThrow(/Cannot load loop extension.*pi-web-access/);
  });

  it("resolves extension paths and records package versions", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ extensions: ["./bridge", "./provider.ts"] }),
      "provider.ts": "export default () => {};",
    });
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(path.join(dir, "bridge"));
    fs.writeFileSync(
      path.join(dir, "bridge", "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    expect(loadLoopSettings(settingsPath).extensions).toEqual([
      { path: path.join(dir, "bridge"), version: "1.2.3" },
      { path: path.join(dir, "provider.ts") },
    ]);
  });

  it.each(["bridge", [42], [""], ["  "]])("rejects invalid extension lists (%j)", (extensions) => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ extensions }),
    });
    expect(() => loadLoopSettings(settingsPath)).toThrow(
      /extensions.*array of non-empty file paths/,
    );
  });

  it("rejects missing extensions before creating a run", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ extensions: ["./missing.ts"] }),
    });
    expect(() => loadLoopSettings(settingsPath)).toThrow(/Cannot load loop extension.*missing.ts/);
  });

  it("parses per-role skill short names", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({
        implementSkills: ["tdd"],
        repairSkills: ["deslop"],
        reviewSkills: [],
      }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.implement.skills).toEqual(["tdd"]);
    expect(settings.repair.skills).toEqual(["deslop"]);
    expect(settings.review.skills).toEqual([]);
  });

  it("overrides repair rounds, watchdog policy, and controller deadlines", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({
        repairRounds: 5,
        watchdog: { silenceMs: 1000, hardCeilingMs: 5000 },
        deadlines: { checkMs: 2000 },
      }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.repairRounds).toBe(5);
    expect(settings.watchdog).toEqual({
      ...DEFAULT_WATCHDOG,
      silenceMs: 1000,
      hardCeilingMs: 5000,
    });
    expect(settings.deadlines).toEqual({ ...DEFAULT_DEADLINES, checkMs: 2000 });
  });

  it("overrides the controller recovery policy", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({
        recovery: { transientRetries: 1, transientBackoffMs: [10, 20] },
      }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.recovery).toEqual({ transientRetries: 1, transientBackoffMs: [10, 20] });
  });

  it.each([
    [{ repairRounds: -1 }, /repairRounds/],
    [{ repairRounds: 1.5 }, /repairRounds/],
    [{ repairRounds: 11 }, /repairRounds/],
    [{ watchdog: { silenceMs: 0 } }, /watchdog.silenceMs/],
    [{ watchdog: [] }, /watchdog/],
    [{ recovery: { transientRetries: -1 } }, /recovery.transientRetries/],
    [{ recovery: { transientBackoffMs: [10, "soon"] } }, /recovery.transientBackoffMs/],
    [{ recovery: [] }, /recovery/],
    [{ deadlines: { gitMs: "soon" } }, /deadlines.gitMs/],
  ])("rejects invalid policy settings (%j)", (config, pattern) => {
    const settingsPath = writeSettingsDir({ "loop-settings.json": JSON.stringify(config) });
    expect(() => loadLoopSettings(settingsPath)).toThrow(pattern);
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
    // The PR-description worker always needs the pr skill.
    fs.mkdirSync(path.join(curated, "pr"), { recursive: true });
    fs.writeFileSync(path.join(curated, "pr", "SKILL.md"), "# pr\n", "utf8");
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementSkills: ["tdd"], repairSkills: [] }),
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

  it("loads the blessed loop agent files with non-editing review tools", () => {
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
    expect(settings.implement.model).toBe("claude-bridge/claude-opus-5-5");
    expect(settings.implement.thinking).toBe("medium");
    expect(settings.implement.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "web_search",
      "fetch_content",
      "get_search_content",
    ]);
    expect(settings.implement.skills).toEqual(["tdd", "diagnosing-bugs", "deslop"]);
    expect(settings.implement.promptBody).toContain("/skill:tdd");
    expect(settings.review.agentName).toBe("loop-reviewer");
    expect(settings.review.model).toBe("openai-codex/gpt-6.1-sol");
    expect(settings.review.thinking).toBe("high");
    expect(settings.review.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(settings.review.skills).toEqual([]);
    expect(settings.review.promptBody).toContain("## Flag gate");
    expect(() => validateLoopSkills(settings)).not.toThrow();
  });

  it("rejects a review agent that requests editing tools", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ reviewAgent: "./review.md" }),
      "review.md": `---\ndescription: Rogue reviewer\ntools: read, edit\n---\n\nReview.`,
    });
    expect(() => loadLoopSettings(settingsPath)).toThrow(/must not edit files/);
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

  it.each(["ultra", "none"])("rejects unsupported thinking level %s", (thinking) => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementAgent: "./implement.md" }),
      "implement.md": `---\ndescription: Thinker\nthinking: ${thinking}\n---\n\nImplement.`,
    });
    expect(() => loadLoopSettings(settingsPath)).toThrow(`unknown thinking level "${thinking}"`);
  });
});
