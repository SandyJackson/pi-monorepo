import { describe, expect, it } from "vitest";
import { createCodeTool } from "./code.ts";
import { failed, ok, setup as setupTool, text } from "./test-support.ts";

const setup = (result: Parameters<typeof setupTool>[1]) => setupTool(createCodeTool, result);

const hit = {
  repo: "earendil-works/pi",
  path: "packages/ai/test/stream.test.ts",
  line: 350,
  snippet: 'describe.skipIf(!process.env.GEMINI_API_KEY)("Gemini", () => {',
  url: "https://github.com/earendil-works/pi/blob/main/packages/ai/test/stream.test.ts",
  source: "grepapp",
};

describe("ketch_code", () => {
  it("searches public code and returns each match as a fenced snippet", async () => {
    const { run, argv, conforms } = setup(ok([hit]));
    const r = await run({ query: "describe.skipIf" });

    expect(argv()).toEqual(["code", "--json", "--", "describe.skipIf"]);
    expect(text(r)).toBe(
      `## [earendil-works/pi/packages/ai/test/stream.test.ts:350](${hit.url})\n\n` +
        "```\n" +
        `${hit.snippet}\n` +
        "```",
    );
    const { source: _, ...expected } = hit;
    expect(r.structuredContent).toEqual({ results: [expected] });
    expect(conforms(r)).toBe(true);
  });

  it("passes repo, language, regex and limit, keeping the query after --", async () => {
    const { run, argv, conforms } = setup(
      ok([
        { repo: "a/b", path: "x.ts", snippet: "-x", url: "https://github.com/a/b", language: "ts" },
      ]),
    );
    const r = await run({ query: "--x", repo: "a/b", lang: "typescript", regex: true, limit: 3 });

    expect(argv()).toEqual([
      "code",
      "--json",
      "--repo=a/b",
      "--lang=typescript",
      "--regex",
      "--limit=3",
      "--",
      "--x",
    ]);
    expect(text(r)).toBe("## [a/b/x.ts](https://github.com/a/b)\n\n```ts\n-x\n```");
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

  it("reports a backend failure as upstream", async () => {
    const { run } = setup(failed(4, "Error: code search failed: grep.app returned status 504\n"));
    const r = await run({ query: "x" });

    expect(r.structuredContent).toEqual({
      error: { kind: "upstream", message: "code search failed: grep.app returned status 504" },
    });
  });
});
