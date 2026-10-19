import { describe, expect, it } from "vitest";
import { isActionableHookFailure } from "./artifact.ts";

describe("isActionableHookFailure", () => {
  it.each([
    ["source diagnostic", "feature.txt:1:1 error: Unexpected token"],
    ["TypeScript diagnostic", "feature.ts(1,1): error TS2322: Type mismatch"],
    ["Biome lint diagnostic", "feature.ts:1:7 lint/correctness/noUnusedVariables  FIXABLE"],
    ["Biome formatting diagnostic", "Formatter would have printed the following content:"],
    ["test assertion", "AssertionError: expected 1 to be 2"],
    ["Rust diagnostic", "error[E0308]: mismatched types"],
  ])("recognizes a repairable %s", (_label, diagnostic) => {
    expect(isActionableHookFailure(diagnostic)).toBe(true);
  });

  it.each([
    ["missing tool", "pnpm: command not found"],
    [
      "missing hook interpreter",
      "fatal: cannot run .git/hooks/pre-commit: No such file or directory",
    ],
    ["missing linker", "error: linker `cc` not found"],
    [
      "missing hook interpreter diagnostic",
      "error: cannot run .git/hooks/pre-commit: No such file or directory",
    ],
    [
      "missing tool after a source diagnostic",
      "feature.ts:1:1 error: Unexpected token\npnpm: command not found",
    ],
    [
      "missing tool before long compiler output",
      [
        "pnpm: command not found",
        ...Array(100).fill("feature.ts:1:1 error: Unexpected token"),
      ].join("\n"),
    ],
    [
      "missing shell command after a source diagnostic",
      "feature.ts:1:1 error: Unexpected token\npre-commit: 1: pnpm: not found",
    ],
    ["runner startup failure", "FAIL tests/example.test.ts\nError: Cannot find package 'vitest'"],
    ["unclassified error count", "Found 1 error"],
    ["unclassified failure symbol", "✖ Hook setup failed"],
    ["unrecognized diagnostic", "STDOUT_DIAGNOSTIC\nSTDERR_DIAGNOSTIC"],
  ])("refuses to repair a %s", (_label, diagnostic) => {
    expect(isActionableHookFailure(diagnostic)).toBe(false);
  });
});
