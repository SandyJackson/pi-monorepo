/**
 * Bash Command Extraction Validation
 * ======================================
 *
 * Tests the tree-sitter-based command extraction module against the
 * acceptance criteria from issue #4.
 *
 * Usage:
 *   cd llm-tooling/pi/agent/extensions/bash-permission
 *   npx tsx validate-extract.ts
 */

import { extractCommands } from "./lib/bash-extract.ts";

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  } else {
    passed++;
  }
}

function assertDeepEqual<T>(actual: T, expected: T, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    console.error(`  ✗ FAIL: ${label}`);
    console.error(`      expected: ${expectedJson}`);
    console.error(`      actual:   ${actualJson}`);
    failed++;
  } else {
    passed++;
  }
}

function section(name: string): void {
  console.log(`\n  ${name}`);
}

function extract(input: string): string[] {
  const result = extractCommands(input);
  if (result.error) {
    console.error(`  UNEXPECTED ERROR: ${result.error} for input: ${JSON.stringify(input)}`);
    return ["__ERROR__" + result.error];
  }
  return result.commands;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("  bash command extraction validation");
console.log("  =============================================");

// --- AC1: Simple commands ---
section("AC1: Simple commands");

assertDeepEqual(extract("git status"), ["git status"], "git status");
assertDeepEqual(extract("ls -la"), ["ls -la"], "ls -la");
assertDeepEqual(extract("pwd"), ["pwd"], "pwd");
assertDeepEqual(extract("echo hello world"), ["echo hello world"], "echo hello world");
assertDeepEqual(extract("/usr/bin/git diff HEAD"), ["/usr/bin/git diff HEAD"], "full path command");

// --- AC2: Chained commands ---
section("AC2: Chained commands (&&, ||, ;)");

assertDeepEqual(
  extract("git log && echo done"),
  ["git log", "echo done"],
  "&& chain",
);
assertDeepEqual(
  extract("cd dir || mkdir dir"),
  ["cd dir", "mkdir dir"],
  "|| chain",
);
assertDeepEqual(
  extract("cd dir; echo done"),
  ["cd dir", "echo done"],
  "semicolon chain",
);
assertDeepEqual(
  extract("git add . && git commit -m 'feat' && git push"),
  ["git add .", "git commit -m 'feat'", "git push"],
  "triple && chain",
);

// --- AC3: Pipeline commands ---
section("AC3: Pipeline commands");

assertDeepEqual(
  extract("git log | grep fix"),
  ["git log", "grep fix"],
  "simple pipe",
);
assertDeepEqual(
  extract("cat file | grep foo | head -5"),
  ["cat file", "grep foo", "head -5"],
  "triple pipe",
);
assertDeepEqual(
  extract("echo a | echo b"),
  ["echo a", "echo b"],
  "two-element pipe",
);

// --- AC4: Subshell commands ---
section("AC4: Subshell commands");

assertDeepEqual(
  extract("(cd dir && make)"),
  ["cd dir", "make"],
  "subshell with chain",
);
assertDeepEqual(
  extract("(cd dir)"),
  ["cd dir"],
  "simple subshell",
);
assertDeepEqual(
  extract("(cd a || cd b) && echo done"),
  ["cd a", "cd b", "echo done"],
  "subshell in chain",
);

// --- AC5: Command substitution ---
section("AC5: Command substitution");

assertDeepEqual(
  extract('echo "$(git log)"'),
  ['echo "$(git log)"', "git log"],
  "command substitution in string",
);
assertDeepEqual(
  extract("echo $(whoami)"),
  ["echo $(whoami)", "whoami"],
  "command substitution bare",
);
assertDeepEqual(
  extract('git log | grep "$(date)"'),
  ["git log", 'grep "$(date)"', "date"],
  "command substitution in pipe",
);

// --- AC6: Redirected statements ---
section("AC6: Redirected statements");

assertDeepEqual(
  extract("echo hello > file"),
  ["echo hello > file"],
  "> redirect",
);
assertDeepEqual(
  extract("cat < input.txt"),
  ["cat < input.txt"],
  "< redirect",
);
assertDeepEqual(
  extract("> /dev/null git status"),
  ["> /dev/null git status"],
  "leading redirect",
);
assertDeepEqual(
  extract("echo hello >> file 2>&1"),
  ["echo hello >> file 2>&1"],
  "append redirect with stderr",
);
assertDeepEqual(
  extract("git log | grep foo > output.txt"),
  ["git log", "grep foo > output.txt"],
  "pipe with redirect on last element",
);

// --- AC7: Parse/extraction failure returns fail-closed ---
section("AC7: Parse/extraction failure → fail-closed");

(function () {
  // Truly malformed syntax should always produce an error
  const result = extractCommands("&&");
  assert(result.error !== null, "standalone && returns error");
  assertDeepEqual(result.commands, [], "standalone && returns no commands");
})();

(function () {
  // Incomplete command substitution should produce an error
  const result = extractCommands('echo "$(pwd');
  assert(result.error !== null, "unclosed substitution returns error");
  assertDeepEqual(result.commands, [], "unclosed substitution returns no commands");
})();

(function () {
  // Incomplete function definition should produce an error
  const result = extractCommands("function foo() {");
  assert(result.error !== null, "incomplete function body returns error");
  assertDeepEqual(result.commands, [], "incomplete function body returns no commands");
})();

(function () {
  // Empty input should produce no commands (not an error — just no commands)
  const result = extractCommands("");
  assert(result.error === null, "empty input has no error");
  assertDeepEqual(result.commands, [], "empty input produces no commands");
})();

(function () {
  // Whitespace-only input should produce no commands
  const result = extractCommands("   ");
  assert(result.error === null, "whitespace input has no error");
  assertDeepEqual(result.commands, [], "whitespace input produces no commands");
})();

// --- Edge cases ---
section("Edge cases");

assertDeepEqual(
  extract("FOO=bar make"),
  ["FOO=bar make"],
  "environment variable prefix on command",
);
assertDeepEqual(
  extract("export FOO=bar"),
  ["export FOO=bar"],
  "declaration command (export)",
);
assertDeepEqual(
  extract("echo a | echo b | echo c"),
  ["echo a", "echo b", "echo c"],
  "multi-element pipe",
);
assertDeepEqual(
  extract('echo "hello $(whoami)" > /dev/null'),
  ['echo "hello $(whoami)" > /dev/null', "whoami"],
  "redirected command with command substitution",
);
assertDeepEqual(
  extract("for i in 1 2 3; do echo $i; done"),
  ["echo $i"],
  "command inside for loop",
);
assertDeepEqual(
  extract("if true; then echo yes; fi"),
  ["true", "echo yes"],
  "commands inside if statement",
);

// Combined: pipe + subshell
assertDeepEqual(
  extract("(cd dir && make) | tee build.log"),
  ["cd dir", "make", "tee build.log"],
  "subshell piped to command",
);

// Combined: redirected pipeline with subshell as last element
assertDeepEqual(
  extract("echo x | (grep x) > out"),
  ["echo x", "grep x > out"],
  "subshell as last pipeline element with redirect",
);

// Combined: redirected pipeline with complex subshell as last element
assertDeepEqual(
  extract("git log | (cd dir && make) > out"),
  ["git log", "cd dir", "make > out"],
  "complex subshell as last pipeline element with redirect",
);

// Combined: redirected pipeline with subshell left side
assertDeepEqual(
  extract("(cd dir && make) | tee build.log > out"),
  ["cd dir", "make", "tee build.log > out"],
  "redirected pipeline with subshell left side",
);

// Combined: chain + pipe + redirect
assertDeepEqual(
  extract("git log | grep fix > output.txt && echo done"),
  ["git log", "grep fix > output.txt", "echo done"],
  "chain of pipe-with-redirect and echo",
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed;
console.log(`\n  Total:  ${total}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  console.log(`  ❌ Some tests failed.`);
  process.exit(1);
} else {
  console.log(`  ✅ All tests passed.`);
}
