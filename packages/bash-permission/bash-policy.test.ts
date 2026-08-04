import { describe, it, expect } from "vitest";
import {
  parseConfig,
  normalizePolicy,
  mergeRules,
  matchPattern,
  evaluateCommand,
  resolveAgentIdentity,
  evaluate,
  type BashConfig,
  type BashRule,
} from "./lib/bash-policy.js";

describe("bash-policy", () => {
  describe("config parsing", () => {
    it("parses valid blanket config", () => {
      const raw = { version: 1, bash: "ask" };
      const cfg = parseConfig(raw);
      expect(cfg).not.toBeNull();
      expect(cfg!.bash).toBe("ask");
    });

    it("parses valid pattern config", () => {
      const raw = { version: 1, bash: { "*": "ask", "git *": "allow" } };
      const cfg = parseConfig(raw);
      expect(cfg).not.toBeNull();
    });

    it("rejects null config", () => {
      expect(parseConfig(null)).toBeNull();
    });

    it("rejects string config", () => {
      expect(parseConfig("not an object")).toBeNull();
    });

    it("rejects invalid bash field", () => {
      expect(parseConfig({ version: 1, bash: 42 })).toBeNull();
    });

    it("rejects invalid action", () => {
      expect(parseConfig({ version: 1, bash: "maybe" })).toBeNull();
    });

    it("defaults version to 1", () => {
      const cfg = parseConfig({ bash: "ask" });
      expect(cfg).not.toBeNull();
      expect(cfg!.version).toBe(1);
    });
  });

  describe("policy normalisation", () => {
    it("normalises blanket policy to single rule", () => {
      const rules = normalizePolicy("ask");
      expect(rules).toEqual([{ pattern: "*", action: "ask" }]);
    });

    it("normalises pattern object to ordered rules", () => {
      const rules = normalizePolicy({ "*": "ask", "git *": "allow" });
      expect(rules).toEqual([
        { pattern: "*", action: "ask" },
        { pattern: "git *", action: "allow" },
      ]);
    });
  });

  describe("rule merging", () => {
    it("merges global and agent rules", () => {
      const globalRules: BashRule[] = [{ pattern: "git *", action: "ask" }];
      const agentRules: BashRule[] = [{ pattern: "git diff *", action: "allow" }];
      const merged = mergeRules(globalRules, agentRules);
      expect(merged).toEqual([
        { pattern: "git *", action: "ask" },
        { pattern: "git diff *", action: "allow" },
      ]);
    });

    it("returns only global rules when agent rules undefined", () => {
      const globalRules: BashRule[] = [{ pattern: "*", action: "ask" }];
      expect(mergeRules(globalRules, undefined)).toEqual(globalRules);
    });
  });

  describe("wildcard matching", () => {
    it("* matches anything", () => {
      expect(matchPattern("anything at all", "*")).toBe(true);
      expect(matchPattern("", "*")).toBe(true);
    });

    it("git * matches git commands", () => {
      expect(matchPattern("git status", "git *")).toBe(true);
      expect(matchPattern("git diff HEAD", "git *")).toBe(true);
      expect(matchPattern("ls -la", "git *")).toBe(false);
    });

    it("? matches single character", () => {
      expect(matchPattern("cat", "c?t")).toBe(true);
      expect(matchPattern("cut", "c?t")).toBe(true);
      expect(matchPattern("ct", "c?t")).toBe(false);
      expect(matchPattern("caat", "c?t")).toBe(false);
    });

    it("trailing * also matches no-argument form", () => {
      expect(matchPattern("git status", "git status *")).toBe(true);
      expect(matchPattern("git status --short", "git status *")).toBe(true);
    });
  });

  describe("agent identity resolution", () => {
    it("resolves null to main", () => {
      expect(resolveAgentIdentity(null)).toBe("main");
    });

    it("resolves undefined to main", () => {
      expect(resolveAgentIdentity(undefined)).toBe("main");
    });

    it("resolves empty string to main", () => {
      expect(resolveAgentIdentity("")).toBe("main");
    });

    it("resolves valid tag to agent name", () => {
      expect(resolveAgentIdentity('<active_agent name="code-reviewer"/>')).toBe("code-reviewer");
    });

    it("returns null for multiple tags", () => {
      const content = `
        <active_agent name="agent-a"/>
        <active_agent name="agent-b"/>
      `;
      expect(resolveAgentIdentity(content)).toBeNull();
    });

    it("returns null for malformed tag", () => {
      expect(resolveAgentIdentity('<active_agent name=foo/>')).toBeNull();
    });
  });

  describe("command evaluation", () => {
    it("returns ask for no matching rule", () => {
      const rules: BashRule[] = [{ pattern: "git *", action: "allow" }];
      const result = evaluateCommand("ls -la", rules);
      expect(result.action).toBe("ask");
      expect(result.matchedRule).toBeNull();
    });

    it("uses last matching rule", () => {
      const rules: BashRule[] = [
        { pattern: "git *", action: "ask" },
        { pattern: "git diff *", action: "allow" },
      ];
      const result = evaluateCommand("git diff HEAD", rules);
      expect(result.action).toBe("allow");
      expect(result.matchedRule?.pattern).toBe("git diff *");
    });
  });

  describe("full evaluation pipeline", () => {
    it("denies null identity", () => {
      const config: BashConfig = { version: 1, bash: "allow" };
      const result = evaluate("anything", config, null);
      expect(result.action).toBe("deny");
      expect(result.agentIdentity).toBe("<fail-closed>");
    });

    it("applies global rules for main agent", () => {
      const config: BashConfig = {
        version: 1,
        bash: { "*": "ask", "git status": "allow" },
      };
      const result = evaluate("git status", config, "main");
      expect(result.action).toBe("allow");
    });

    it("applies agent overrides", () => {
      const config: BashConfig = {
        version: 1,
        bash: { "*": "ask", "git *": "allow" },
        agents: {
          "code-reviewer": { bash: { "git diff *": "deny" } },
        },
      };
      const result = evaluate("git diff HEAD", config, "code-reviewer");
      expect(result.action).toBe("deny");
      expect(result.matchedRule?.pattern).toBe("git diff *");
    });
  });
});
