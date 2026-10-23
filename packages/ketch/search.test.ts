import { describe, expect, it } from "vitest";
import { createSearchTool } from "./search.ts";
import { ok, setup as setupTool, text } from "./test-support.ts";

const setup = (result: Parameters<typeof setupTool>[1]) => setupTool(createSearchTool, result);

const hit = {
  title: "describe | Vitest",
  url: "https://vitest.dev/api/describe",
  description: "Use describe.skipIf from &#x27;vitest&#x27; &amp; skip the suite.",
};

describe("ketch_search", () => {
  it("searches the default backend and returns linked results", async () => {
    const { run, argv, conforms } = setup(ok([hit]));
    const r = await run({ query: "vitest skipIf" });

    expect(argv()).toEqual(["search", "--json", "--", "vitest skipIf"]);
    expect(text(r)).toBe(
      "## [describe | Vitest](https://vitest.dev/api/describe)\n\n" +
        "Use describe.skipIf from 'vitest' & skip the suite.",
    );
    expect(r.structuredContent).toEqual({
      results: [{ ...hit, description: "Use describe.skipIf from 'vitest' & skip the suite." }],
    });
    expect(conforms(r)).toBe(true);
  });

  it("caps scraped pages at 6000 characters by default", async () => {
    const { run, argv } = setup(ok([]));
    await run({ query: "q", scrape: true });
    expect(argv()).toEqual(["search", "--json", "--scrape", "--max-chars=6000", "--", "q"]);
  });

  it("passes limit, multi and an explicit page cap, and shows which backends found each result", async () => {
    const results = [
      { ...hit, content: "# describe", backends: ["brave", "ddg"] },
      { title: "Test | Vitest", url: "https://vitest.dev/api/test", backends: ["ddg"] },
    ];
    const { run, argv, conforms } = setup(ok(results));
    const r = await run({
      query: "-q",
      limit: 5,
      multi: ["brave", "ddg"],
      scrape: true,
      max_chars: 300,
    });

    expect(argv()).toEqual([
      "search",
      "--json",
      "--limit=5",
      "--multi=brave,ddg",
      "--scrape",
      "--max-chars=300",
      "--",
      "-q",
    ]);
    expect(text(r)).toBe(
      "## [1. describe | Vitest](https://vitest.dev/api/describe)\n" +
        "Backends: brave, ddg\n\n" +
        "Use describe.skipIf from 'vitest' & skip the suite.\n\n" +
        "# describe\n\n" +
        "## [2. Test | Vitest](https://vitest.dev/api/test)\n" +
        "Backends: ddg",
    );
    expect(conforms(r)).toBe(true);
  });

  it("ignores max_chars without scrape", async () => {
    const { run, argv } = setup(ok([]));
    await run({ query: "q", max_chars: 300 });
    expect(argv()).toEqual(["search", "--json", "--", "q"]);
  });

  it.each([
    [{ query: " " }, "query is empty"],
    [{ query: "q", multi: ["brave,ddg"] }, '"brave,ddg" is not a backend name'],
  ])("rejects %j without running ketch", async (params, message) => {
    const { exec, run, conforms } = setup(ok([]));
    const r = await run(params);

    expect(exec).not.toHaveBeenCalled();
    expect(r.structuredContent).toEqual({ error: { kind: "validation", message } });
    expect(conforms(r)).toBe(true);
  });

  it("says when nothing matched", async () => {
    const { run, conforms } = setup(ok([]));
    const r = await run({ query: "q" });

    expect(text(r)).toBe("No results.");
    expect(r.structuredContent).toEqual({ results: [] });
    expect(conforms(r)).toBe(true);
  });
});
