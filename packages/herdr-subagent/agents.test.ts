import { describe, expect, it } from "vitest";
import { parseAgentFileContent } from "./agents.js";

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

  it("extracts thinking level and treats none as unset", () => {
    const parsed = parseAgentFileContent(
      `---
description: Thinker
thinking: high
---

Body.`,
      "agent",
    );
    expect(parsed.thinking).toBe("high");
    const none = parseAgentFileContent(
      `---
description: Plain
thinking: none
---

Body.`,
      "agent",
    );
    expect(none.thinking).toBeUndefined();
  });
});
