import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_IMPLEMENT_TOOLS, DEFAULT_REVIEW_TOOLS, loadLoopSettings } from "./settings.js";

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
        promptBody: "Implement the ticket.",
      },
      review: {
        agentName: "review",
        model: "provider/review-model",
        tools: ["read", "grep", "find", "ls"],
        promptBody: "Review the patch.",
      },
      appendSystemPrompt: "Prefer small changes.",
    });
  });

  it("falls back to loop defaults when no agents are configured", () => {
    const settingsPath = writeSettingsDir({ "loop-settings.json": "{}" });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.implement).toEqual({
      agentName: undefined,
      model: undefined,
      tools: DEFAULT_IMPLEMENT_TOOLS,
      promptBody: undefined,
    });
    expect(settings.review.tools).toEqual(DEFAULT_REVIEW_TOOLS);
    expect(settings.appendSystemPrompt).toBeUndefined();
  });

  it("ignores unknown top-level keys", () => {
    const settingsPath = writeSettingsDir({
      "loop-settings.json": JSON.stringify({ implementModel: "provider/x" }),
    });
    const settings = loadLoopSettings(settingsPath);
    expect(settings.appendSystemPrompt).toBeUndefined();
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
});
