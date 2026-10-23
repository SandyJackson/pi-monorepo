import { describe, expect, it } from "vitest";
import { createDocsTool } from "./docs.ts";
import { failed, ok, setup as setupTool, text } from "./test-support.ts";

const setup = (result: Parameters<typeof setupTool>[1]) => setupTool(createDocsTool, result);

const snippet = {
  library: "/vitest-dev/vitest",
  title: "test.skipIf",
  snippet: "## test.skipIf\n\nSkip the test when the condition is truthy.",
  url: "https://github.com/vitest-dev/vitest/blob/main/docs/api/test.md",
  source: "context7",
};

describe("ketch_docs", () => {
  it("searches documentation and names each result's library", async () => {
    const { run, argv, conforms } = setup(ok([snippet]));
    const r = await run({ query: "vitest skipIf" });

    expect(argv()).toEqual(["docs", "--json", "--", "vitest skipIf"]);
    expect(text(r)).toBe(
      `## [test.skipIf](${snippet.url})\nLibrary: /vitest-dev/vitest\n\n` +
        "## test.skipIf\n\nSkip the test when the condition is truthy.",
    );
    const { source: _, ...expected } = snippet;
    expect(r.structuredContent).toEqual({ results: [expected] });
    expect(conforms(r)).toBe(true);
  });

  it("searches one library with a token budget", async () => {
    const { run, argv } = setup(ok([snippet]));
    await run({ query: "skipIf", library: "/vitest-dev/vitest", tokens: 2000 });

    expect(argv()).toEqual([
      "docs",
      "--json",
      "--library=/vitest-dev/vitest",
      "--tokens=2000",
      "--",
      "skipIf",
    ]);
  });

  it("resolves a library name to IDs, showing a few versions", async () => {
    const versions = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"];
    const { run, argv, conforms } = setup(
      ok([
        {
          id: "/vitest-dev/vitest",
          title: "Vitest",
          description: "Next-generation testing framework.",
          totalSnippets: 6062,
          trustScore: 8.3,
          versions,
        },
        { id: "/websites/vitest_dev", title: "Vitest" },
      ]),
    );
    const r = await run({ query: "vitest", resolve: true });

    expect(argv()).toEqual(["docs", "--json", "--resolve", "--", "vitest"]);
    expect(text(r)).toBe(
      "## 1. Vitest\nLibrary ID: /vitest-dev/vitest\n6062 snippets\n" +
        "Versions: v1, v2, v3, v4, v5, v6, v7, v8\nNext-generation testing framework.\n\n" +
        "## 2. Vitest\nLibrary ID: /websites/vitest_dev",
    );
    expect(r.structuredContent).toEqual({
      libraries: [
        {
          id: "/vitest-dev/vitest",
          title: "Vitest",
          description: "Next-generation testing framework.",
          versions: versions.slice(0, 8),
          snippets: 6062,
        },
        { id: "/websites/vitest_dev", title: "Vitest" },
      ],
    });
    expect(conforms(r)).toBe(true);
  });

  it.each([" ", ""])("rejects the blank query %j without running ketch", async (query) => {
    const { exec, run, conforms } = setup(ok([]));
    const r = await run({ query });

    expect(exec).not.toHaveBeenCalled();
    expect(r.structuredContent).toEqual({
      error: { kind: "validation", message: "query is empty" },
    });
    expect(conforms(r)).toBe(true);
  });

  it("rejects resolve together with library", async () => {
    const { exec, run } = setup(ok([]));
    const r = await run({ query: "vitest", resolve: true, library: "/vitest-dev/vitest" });

    expect(exec).not.toHaveBeenCalled();
    expect(r.structuredContent).toMatchObject({ error: { kind: "validation" } });
  });

  it("reports an unknown library as not_found, keeping ketch's hint", async () => {
    const { run, conforms } = setup(
      failed(
        3,
        'Error: docs fetch failed: context7: library "/nope/nope" not found (resolve the exact ID with: ketch docs --resolve <name>)\n',
      ),
    );
    const r = await run({ query: "x", library: "/nope/nope" });

    expect(text(r)).toMatch(/^\[not_found\] docs fetch failed: .*--resolve <name>\) \(no such/);
    expect(conforms(r)).toBe(true);
  });
});
