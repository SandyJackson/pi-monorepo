import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentConfig,
  discoverProjectAgents,
  mergeAgentLists,
  parseAgentFileContent,
} from "./agents.ts";

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

describe("discoverProjectAgents", () => {
  it.each(["0", "-1", "1.5", "nope", "true", "null", '"90"', "[]", "{}"])(
    "rejects invalid timeout %s with the agent file and requirement",
    (timeout) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-agents-"));
      try {
        const agentsDir = path.join(root, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        const agentPath = path.join(agentsDir, "alpha.md");
        fs.writeFileSync(
          agentPath,
          `---\nname: alpha\ndescription: Alpha\ntimeout: ${timeout}\n---\n`,
        );

        expect(() => discoverProjectAgents(root)).toThrow(
          `${agentPath}: frontmatter \`timeout\` must be a positive integer number of minutes`,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("mergeAgentLists", () => {
  function agent(name: string, source: AgentConfig["source"]): AgentConfig {
    return {
      name,
      description: `${name} from ${source}`,
      systemPromptBody: "",
      source,
      sourceDir: `/${source}`,
      filePath: `/${source}/${name}.md`,
    };
  }

  it("lets a project agent replace a user agent, and a user agent a workspace one, of the same name", () => {
    const merged = mergeAgentLists(
      [agent("reviewer", "user"), agent("scout", "user")],
      [agent("reviewer", "project")],
      [agent("reviewer", "workspace"), agent("scout", "workspace"), agent("planner", "workspace")],
    );

    expect(merged.map((config) => [config.name, config.source])).toEqual([
      ["planner", "workspace"],
      ["reviewer", "project"],
      ["scout", "user"],
    ]);
  });
});
