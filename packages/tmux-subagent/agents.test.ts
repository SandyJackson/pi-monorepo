import { describe, expect, it, vi } from "vitest";
import { type AgentConfig, parseAgentFileContent, resolveAgent } from "./agents.js";

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
      thinking: undefined,
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

  it("extracts thinking level", () => {
    const parsed = parseAgentFileContent(
      `---
description: Thinker
thinking: high
---

Body.`,
      "agent",
    );
    expect(parsed.thinking).toBe("high");
  });
});

describe("resolveAgent", () => {
  const alpha: AgentConfig = {
    name: "alpha",
    description: "Alpha agent",
    systemPromptBody: "",
    source: "user",
    sourceDir: "/agents",
    filePath: "/agents/alpha.md",
  };

  it("returns the named agent", () => {
    expect(resolveAgent("alpha", [alpha], "user")).toBe(alpha);
  });

  it("returns a code for an unknown agent", () => {
    expect(resolveAgent("missing", [alpha], "user")).toEqual({
      problem: "unknown_agent",
      name: "missing",
    });
  });

  it("returns a code naming the user agents directory when there are no agents", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/pi-agent");
    try {
      expect(resolveAgent("alpha", [], "both")).toEqual({
        problem: "no_agents",
        scope: "both",
        userAgentsDir: "/pi-agent/agents",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
