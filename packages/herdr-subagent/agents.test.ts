import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiAgentArgs, loadAgentFile, parseAgentFileContent } from "./agents.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeTempFile(fileName: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
  roots.push(dir);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("parseAgentFileContent", () => {
  it("extracts model, tools and body with the filename as fallback name", () => {
    const parsed = parseAgentFileContent(
      `---
description: Loop reviewer
model: openai-codex/gpt-5.6-sol
tools: read, grep, find, ls
---

Review the patch.`,
      "loop-review",
    );
    expect(parsed).toEqual({
      name: "loop-review",
      description: "Loop reviewer",
      tools: ["read", "grep", "find", "ls"],
      model: "openai-codex/gpt-5.6-sol",
      systemPromptBody: "Review the patch.",
    });
  });

  it("prefers the frontmatter name and parses array-form tools", () => {
    const parsed = parseAgentFileContent(
      `---
name: custom
description: Custom agent
tools: [read, bash]
---

Body.`,
      "fallback",
    );
    expect(parsed.name).toBe("custom");
    expect(parsed.tools).toEqual(["read", "bash"]);
  });

  it("treats model none as unset", () => {
    const parsed = parseAgentFileContent(
      `---
description: No model
model: none
---

Body.`,
      "agent",
    );
    expect(parsed.model).toBeUndefined();
  });
});

describe("loadAgentFile", () => {
  it("reads and parses an agent file from disk", () => {
    const filePath = writeTempFile(
      "implement.md",
      `---
description: Loop implementer
model: provider/model-id
tools: read, edit
---

Implement it.`,
    );
    expect(loadAgentFile(filePath)).toEqual({
      name: "implement",
      description: "Loop implementer",
      tools: ["read", "edit"],
      model: "provider/model-id",
      systemPromptBody: "Implement it.",
    });
  });

  it("throws for a missing file", () => {
    expect(() => loadAgentFile(path.join(os.tmpdir(), "no-such-agent.md"))).toThrow();
  });
});

describe("buildPiAgentArgs", () => {
  it("emits model and tools flags when both are set", () => {
    expect(buildPiAgentArgs({ model: "provider/model-id", tools: ["read", "bash"] })).toEqual([
      "--model",
      "provider/model-id",
      "--tools",
      "read,bash",
    ]);
  });

  it("emits nothing when neither is set", () => {
    expect(buildPiAgentArgs({})).toEqual([]);
    expect(buildPiAgentArgs({ tools: [] })).toEqual([]);
  });
});
