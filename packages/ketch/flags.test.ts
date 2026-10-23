// Fails when a ketch release drops or renames a flag a tool sends. Each tool's
// flags come from calls that set every parameter, captured with a fake
// runner; the real binary only prints help. Skipped when ketch isn't on PATH.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createCodeTool } from "./code.ts";
import { createDocsTool } from "./docs.ts";
import { createScrapeTool } from "./scrape.ts";
import { createSearchTool } from "./search.ts";
import { ok, setup } from "./test-support.ts";

function onPath(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Calls that between them set every parameter of every tool.
const tools = [
  {
    create: createSearchTool,
    params: { query: "q", limit: 1, multi: ["brave"], scrape: true, max_chars: 1 },
  },
  {
    create: createCodeTool,
    params: { query: "q", repo: "a/b", lang: "go", regex: true, limit: 1 },
  },
  { create: createDocsTool, params: { query: "q", library: "/a/b", tokens: 100 } },
  { create: createDocsTool, params: { query: "q", resolve: true } },
  {
    create: createScrapeTool,
    params: { url: "https://example.com", selector: "main", max_chars: 1, no_cache: true },
  },
];

/** `--flag` names before the `--` that ends the options. */
function flagsOf(argv: string[]): string[] {
  return argv
    .slice(0, argv.indexOf("--"))
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => arg.split("=")[0]);
}

describe.skipIf(!onPath("ketch"))("flags sent to ketch", () => {
  const sent = new Map<string, Set<string>>();
  const help = new Map<string, string>();

  beforeAll(async () => {
    for (const { create, params } of tools) {
      const tool = setup(create as typeof createSearchTool, ok([]));
      await tool.run(params as never);
      const argv = tool.argv()!;
      const flags = sent.get(argv[0]) ?? new Set();
      for (const f of flagsOf(argv)) flags.add(f);
      sent.set(argv[0], flags);
    }
    const run = promisify(execFile);
    await Promise.all(
      [...sent.keys()].map(async (command) => {
        const { stdout } = await run("ketch", [command, "--help"]);
        help.set(command, stdout);
      }),
    );
  });

  it("covers every command the tools run", () => {
    expect([...sent.keys()].sort()).toEqual(["code", "docs", "scrape", "search"]);
  });

  it.each(["search", "code", "docs", "scrape"])("ketch %s still accepts every flag", (command) => {
    const missing = [...(sent.get(command) ?? [])].filter(
      (f) => !new RegExp(`(^|\\s)${f}(\\s|=|\\[|$)`, "m").test(help.get(command) ?? ""),
    );
    expect(missing).toEqual([]);
  });
});
