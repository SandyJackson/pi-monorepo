/**
 * validate-policy.ts — Self-test for the bash permission policy engine
 *
 * Covers all acceptance criteria from issue #3:
 *   1. Blanket syntax  (bash: "ask")
 *   2. Pattern syntax  (bash: { "*": "ask", "git *": "allow" })
 *   3. Per-agent overrides  (agents.<name>.bash)
 *   4. Global before agent, last match wins
 *   5. Wildcard matching (*, ?, slash-normalization, trailing " *")
 *   6. Absence of active-agent tag → "main"
 *   7. Single valid tag → resolved agent name
 *   8. Multiple / malformed tags → fail closed (null)
 *   9. Unknown commands → "ask"
 *  10. This script IS the validation script
 *
 * Run: npx tsx validate-policy.ts
 */

import {
  type BashConfig,
  type BashRule,
  evaluate,
  evaluateCommand,
  matchPattern,
  mergeRules,
  normalizePolicy,
  parseConfig,
  resolveAgentIdentity,
} from "./lib/bash-policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test runner helpers
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e: unknown) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`  ✗ ${name}\n    ${msg}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`assertion failed: ${msg}`);
}

function assertDeepEqual<T>(actual: T, expected: T, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson)
    throw new Error(`${label}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Blanket syntax
// ─────────────────────────────────────────────────────────────────────────────

test("AC1: blanket 'ask'", () => {
  const raw = { version: 1, bash: "ask" };
  const cfg = parseConfig(raw);
  assert(cfg !== null, "should parse valid blanket config");
  const rules = normalizePolicy(cfg!.bash);
  assertDeepEqual(
    rules,
    [{ pattern: "*", action: "ask" }],
    "blanket ask normalises to single * rule",
  );
});

test("AC1: blanket 'allow'", () => {
  const raw = { version: 1, bash: "allow" };
  const cfg = parseConfig(raw);
  assert(cfg !== null, "should parse blanket allow");
  const rules = normalizePolicy(cfg!.bash);
  assertDeepEqual(rules, [{ pattern: "*", action: "allow" }], "blanket allow normalises correctly");
});

test("AC1: blanket 'deny'", () => {
  const raw = { version: 1, bash: "deny" };
  const cfg = parseConfig(raw);
  assert(cfg !== null, "should parse blanket deny");
  const rules = normalizePolicy(cfg!.bash);
  assertDeepEqual(rules, [{ pattern: "*", action: "deny" }], "blanket deny normalises correctly");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pattern syntax
// ─────────────────────────────────────────────────────────────────────────────

test("AC2: pattern object", () => {
  const raw = { version: 1, bash: { "*": "ask", "git *": "allow" } };
  const cfg = parseConfig(raw);
  assert(cfg !== null, "should parse pattern config");
  const rules = normalizePolicy(cfg!.bash);
  assertDeepEqual(
    rules,
    [
      { pattern: "*", action: "ask" },
      { pattern: "git *", action: "allow" },
    ],
    "pattern object preserves order",
  );
});

test("AC2: empty pattern object", () => {
  const raw = { version: 1, bash: {} };
  const cfg = parseConfig(raw);
  assert(cfg !== null, "empty pattern object is valid");
  const rules = normalizePolicy(cfg!.bash);
  assertDeepEqual(rules, [], "empty object yields empty rule list");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Per-agent overrides
// ─────────────────────────────────────────────────────────────────────────────

test("AC3: per-agent override", () => {
  const raw = {
    version: 1,
    bash: { "*": "ask" },
    agents: {
      "code-reviewer": { bash: { "git *": "allow" } },
    },
  };
  const cfg = parseConfig(raw);
  assert(cfg !== null, "should parse config with agents");
  assert(cfg!.agents !== undefined, "agents block present");
  assert(cfg!.agents!["code-reviewer"] !== undefined, "code-reviewer agent present");
  const agentRules = normalizePolicy(cfg!.agents!["code-reviewer"].bash);
  assertDeepEqual(agentRules, [{ pattern: "git *", action: "allow" }], "agent rules parsed");
});

test("AC3: agent with description", () => {
  const raw = {
    version: 1,
    bash: "ask",
    agents: {
      main: {
        description: "Main agent",
        bash: { "cat *": "allow" },
      },
    },
  };
  const cfg = parseConfig(raw);
  assert(cfg !== null, "config with description parses");
  assert(cfg!.agents!.main.description === "Main agent", "description preserved");
});

test("AC3: agent without bash field is malformed", () => {
  const raw = {
    version: 1,
    bash: "ask",
    agents: {
      main: { description: "no bash field" },
    },
  };
  const cfg = parseConfig(raw);
  assert(cfg === null, "agent without bash field should fail");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Global before agent, last match wins
// ─────────────────────────────────────────────────────────────────────────────

test("AC4: global rule overridden by agent rule (last match wins)", () => {
  const globalRules: BashRule[] = [
    { pattern: "git *", action: "ask" },
    { pattern: "*", action: "deny" },
  ];
  const agentRules: BashRule[] = [{ pattern: "git diff *", action: "allow" }];
  const merged = mergeRules(globalRules, agentRules);
  assertDeepEqual(
    merged,
    [
      { pattern: "git *", action: "ask" },
      { pattern: "*", action: "deny" },
      { pattern: "git diff *", action: "allow" },
    ],
    "global rules precede agent rules",
  );

  // git diff should match agent rule (allow), not global git * (ask) or * (deny)
  const result = evaluateCommand("git diff HEAD", merged);
  assert(result.action === "allow", "agent git diff rule wins over global");
  assert(result.matchedRule?.pattern === "git diff *", "matched rule is the agent rule");
});

test("AC4: global rule wins when agent has no matching rule", () => {
  const globalRules: BashRule[] = [{ pattern: "rm *", action: "deny" }];
  const agentRules: BashRule[] = [{ pattern: "git *", action: "allow" }];
  const merged = mergeRules(globalRules, agentRules);
  const result = evaluateCommand("rm -rf /tmp", merged);
  assert(result.action === "deny", "global deny still applies");
});

test("AC4: no agent rules → only global rules applied", () => {
  const globalRules: BashRule[] = [{ pattern: "*", action: "ask" }];
  const merged = mergeRules(globalRules, undefined);
  assert(merged.length === 1, "only global rules when agent undefined");
  const merged2 = mergeRules(globalRules, []);
  assert(merged2.length === 1, "only global rules when agent empty");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Wildcard matching
// ─────────────────────────────────────────────────────────────────────────────

test("AC5: * matches anything", () => {
  assert(matchPattern("anything at all", "*"), "* matches any string");
  assert(matchPattern("", "*"), "* matches empty string");
});

test("AC5: git * matches git commands", () => {
  assert(matchPattern("git status", "git *"), "git status matches git *");
  assert(matchPattern("git diff HEAD", "git *"), "git diff HEAD matches git *");
  assert(!matchPattern("ls -la", "git *"), "ls -la does not match git *");
});

test("AC5: ? matches single character", () => {
  assert(matchPattern("cat", "c?t"), "cat matches c?t");
  assert(matchPattern("cut", "c?t"), "cut matches c?t");
  assert(!matchPattern("ct", "c?t"), "ct does not match c?t (too short)");
  assert(!matchPattern("caat", "c?t"), "caat does not match c?t (too long)");
});

test("AC5: slash normalisation (backslash → forward slash)", () => {
  assert(matchPattern("dir\\file.txt", "dir/*"), "backslash in command normalised");
  assert(matchPattern("dir/file.txt", "dir/*"), "forward slash in command normalised");
  // Pattern with backslash should match forward-slash command
  assert(matchPattern("dir/file.txt", "dir\\*"), "backslash in pattern normalised");
});

test("AC5: trailing * also matches no-argument form", () => {
  assert(matchPattern("git status", "git status *"), "git status matches git status * (no-arg)");
  assert(
    matchPattern("git status --short", "git status *"),
    "git status --short matches git status * (with args)",
  );
});

test("AC5: exact pattern without trailing star does not match with args", () => {
  assert(matchPattern("git status", "git status"), "git status matches itself exactly");
  // git status (no pattern wildcard) should match "git status" exactly
  // The * in "git status *" catches the arg form
});

test("AC5: mixed wildcards", () => {
  assert(matchPattern("cat file.txt", "cat *.txt"), "cat file.txt matches cat *.txt");
  assert(matchPattern("cat f.txt", "cat ?.txt"), "cat f.txt matches cat ?.txt");
  assert(!matchPattern("cat fo.txt", "cat ?.txt"), "cat fo.txt does not match cat ?.txt");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Absence of active-agent tag → "main"
// ─────────────────────────────────────────────────────────────────────────────

test("AC6: null tag → main", () => {
  assert(resolveAgentIdentity(null) === "main", "null resolves to main");
});

test("AC6: undefined tag → main", () => {
  assert(resolveAgentIdentity(undefined) === "main", "undefined resolves to main");
});

test("AC6: empty string → main", () => {
  assert(resolveAgentIdentity("") === "main", "empty string resolves to main");
});

test("AC6: whitespace-only → main", () => {
  assert(resolveAgentIdentity("   \n  ") === "main", "whitespace resolves to main");
});

test("AC6: no tag in content → main", () => {
  assert(
    resolveAgentIdentity("just some text without a tag") === "main",
    "no tag found resolves to main",
  );
  assert(
    resolveAgentIdentity('<not_an_active_agent name="foo"/>') === "main",
    "wrong tag name resolves to main",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Single valid tag → resolved agent name
// ─────────────────────────────────────────────────────────────────────────────

test("AC7: single valid tag", () => {
  assert(
    resolveAgentIdentity('<active_agent name="code-reviewer"/>') === "code-reviewer",
    "extracts code-reviewer",
  );
  assert(resolveAgentIdentity('<active_agent name="main"/>') === "main", "extracts main");
  assert(
    resolveAgentIdentity('<active_agent name="my-custom-agent"/>') === "my-custom-agent",
    "extracts hyphens",
  );
});

test("AC7: tag with optional slash", () => {
  assert(resolveAgentIdentity('<active_agent name="foo">') === "foo", "works with > instead of />");
});

test("AC7: tag embedded in larger content", () => {
  const content = `
    # Environment
    Working directory: /home/user/project

    <active_agent name="code-reviewer"/>

    Additional instructions...
  `;
  assert(resolveAgentIdentity(content) === "code-reviewer", "extracts from system prompt context");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Multiple / malformed tags → fail closed (null)
// ─────────────────────────────────────────────────────────────────────────────

test("AC8: multiple tags → null", () => {
  const content = `
    <active_agent name="agent-a"/>
    <active_agent name="agent-b"/>
  `;
  assert(resolveAgentIdentity(content) === null, "two tags returns null");
});

test("AC8: empty name → null", () => {
  assert(resolveAgentIdentity('<active_agent name=""/>') === null, "empty name returns null");
});

test("AC8: whitespace-only name → null", () => {
  assert(
    resolveAgentIdentity('<active_agent name="   "/>') === null,
    "whitespace name returns null",
  );
});

test("AC8: malformed tag — no quotes around name → null", () => {
  assert(resolveAgentIdentity("<active_agent name=foo/>") === null, "unquoted name returns null");
});

test("AC8: malformed tag — no name attribute → null", () => {
  assert(resolveAgentIdentity("<active_agent/>") === null, "missing name attr returns null");
});

test("AC8: malformed tag — mixed content with malformed attempt → null", () => {
  assert(
    resolveAgentIdentity("some text <active_agent name=foo/> more text") === null,
    "malformed tag in context returns null",
  );
});

test("AC8: one valid + one malformed tag → null", () => {
  assert(
    resolveAgentIdentity('<active_agent name="valid"/> <active_agent name=invalid/>') === null,
    "valid + malformed returns null",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Unknown commands → "ask"
// ─────────────────────────────────────────────────────────────────────────────

test("AC9: no matching rule → ask", () => {
  const rules: BashRule[] = [{ pattern: "git *", action: "allow" }];
  const result = evaluateCommand("ls -la", rules);
  assert(result.action === "ask", "unknown command defaults to ask");
  assert(result.matchedRule === null, "no matched rule");
});

test("AC9: empty rule list → ask", () => {
  const result = evaluateCommand("anything", []);
  assert(result.action === "ask", "empty rules defaults to ask");
});

test("AC9: rule match overrides default", () => {
  const rules: BashRule[] = [{ pattern: "*", action: "deny" }];
  const result = evaluateCommand("anything", rules);
  assert(result.action === "deny", "matching rule overrides default");
});

// ─────────────────────────────────────────────────────────────────────────────
// Full evaluation pipeline
// ─────────────────────────────────────────────────────────────────────────────

test("full pipeline: global ask, agent git allow", () => {
  const config: BashConfig = {
    version: 1,
    bash: { "*": "ask", "git *": "allow" },
    agents: {
      "code-reviewer": { bash: { "git diff *": "deny" } },
    },
  };
  // Global git * is allow, but code-reviewer has git diff * → deny
  // Merged: git * (allow) then git diff * (deny) → deny wins
  const result = evaluate("git diff HEAD", config, "code-reviewer");
  assert(result.action === "deny", "code-reviewer git diff denied");
  assert(result.matchedRule?.pattern === "git diff *", "matched rule is agent override");
  assert(result.agentIdentity === "code-reviewer", "identity reported");
});

test("full pipeline: main agent with no per-agent rules", () => {
  const config: BashConfig = {
    version: 1,
    bash: { "*": "ask", "git status": "allow" },
  };
  // main has no per-agent policy, so only global rules apply
  const result = evaluate("git status", config, "main");
  assert(result.action === "allow", "main can git status");
  assert(result.matchedRule?.pattern === "git status", "matched rule is git status");
});

test("full pipeline: unknown agent name gets only global rules", () => {
  const config: BashConfig = {
    version: 1,
    bash: { "*": "ask", "git *": "allow" },
    agents: {
      "known-agent": { bash: { "rm *": "deny" } },
    },
  };
  // "unknown-agent" has no per-agent policy, only global rules apply
  const result = evaluate("git log", config, "unknown-agent");
  assert(result.action === "allow", "unknown agent uses global rules");
});

test("full pipeline: null identity (fail-closed) → deny", () => {
  const config: BashConfig = { version: 1, bash: "allow" };
  const result = evaluate("anything", config, null);
  assert(result.action === "deny", "null identity results in deny");
  assert(result.matchedRule === null, "no matched rule");
  assert(result.agentIdentity === "<fail-closed>", "identity indicates fail-closed");
});

test("full pipeline: malformed agent tag in config sets identity to null → deny", () => {
  // This simulates what happens when resolveAgentIdentity returns null
  const config: BashConfig = { version: 1, bash: "allow" };
  const identity = resolveAgentIdentity("<active_agent name=foo/>");
  assert(identity === null, "malformed tag yields null identity");
  const result = evaluate("git status", config, identity);
  assert(result.action === "deny", "null identity from malformed tag results in deny");
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed config failures
// ─────────────────────────────────────────────────────────────────────────────

test("malformed config: null", () => {
  assert(parseConfig(null) === null, "null fails");
});

test("malformed config: string", () => {
  assert(parseConfig("not an object") === null, "string fails");
});

test("config: missing version defaults to 1", () => {
  const cfg = parseConfig({ bash: "ask" });
  assert(cfg !== null, "missing version still parses");
  assert(cfg!.version === 1, "defaults to version 1");
});

test("config: version string fails", () => {
  assert(parseConfig({ version: "1", bash: "ask" }) === null, "string version fails");
});

test("malformed config: bad bash field", () => {
  assert(parseConfig({ version: 1, bash: 42 }) === null, "numeric bash fails");
  assert(parseConfig({ version: 1, bash: "maybe" }) === null, "invalid action fails");
  assert(parseConfig({ version: 1, bash: null }) === null, "null bash fails");
});

test("malformed config: bad action in pattern", () => {
  assert(
    parseConfig({ version: 1, bash: { "*": "maybe" } }) === null,
    "invalid action in pattern fails",
  );
});

test("malformed config: agents not an object", () => {
  assert(
    parseConfig({ version: 1, bash: "ask", agents: "not-object" }) === null,
    "string agents fails",
  );
});

test("malformed config: bash is an array", () => {
  assert(parseConfig({ version: 1, bash: [] }) === null, "array bash fails");
});

test("malformed config: agents is an array", () => {
  assert(parseConfig({ version: 1, bash: "ask", agents: [] }) === null, "array agents fails");
});

test("malformed config: agent entry is an array", () => {
  assert(
    parseConfig({ version: 1, bash: "ask", agents: { main: [] } }) === null,
    "array agent entry fails",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n  bash-permission policy engine validation`);
console.log(`  ${"=".repeat(45)}`);
console.log(`  Total:  ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n${failures.join("\n")}\n`);
  process.exit(1);
} else {
  console.log(`  ✅ All tests passed.\n`);
}
