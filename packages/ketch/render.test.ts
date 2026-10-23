import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createCodeTool } from "./code.ts";
import { createDocsTool } from "./docs.ts";
import ketch from "./index.ts";
import { callSummary, preview, renderers, resultLines, safeText } from "./render.ts";
import type { KetchResult } from "./result.ts";
import { createScrapeTool } from "./scrape.ts";
import { createSearchTool } from "./search.ts";
import { failed, ok, setup } from "./test-support.ts";

const theme = { fg: (_color: string, s: string) => s, bold: (s: string) => s } as never;
const hostile =
  "ok\x1b[31mRED\x1b[0m\x1b]52;c;clipboard\x07\x1bPpayload\x1b\\\r\x00\u202eend\u202c";
// Escape, bell, NUL and the bidi override and pop that `hostile` carries.
const controls = ["\x1b", "\x07", "\x00", "\u202e", "\u202c"];

function expectNoControls(text: string) {
  for (const c of controls) expect(text).not.toContain(c);
}

function draw(result: KetchResult, options: { expanded?: boolean; isPartial?: boolean } = {}) {
  const { renderResult } = renderers("search");
  return renderResult!(
    result,
    { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
    theme,
    { isError: result.isError } as never,
  )
    .render(100)
    .join("\n");
}

describe("safeText and preview", () => {
  it("strips terminal escapes, controls and bidi overrides", () => {
    expect(safeText(hostile)).toBe("okREDend");
  });

  it("collapses whitespace and bounds length", () => {
    expect(preview("a\n\tb")).toBe("a b");
    expect(preview("a".repeat(1000), 10)).toBe("aaaaaaaaa…");
  });
});

describe("callSummary", () => {
  it("shows the target and the options that were set", () => {
    expect(callSummary({ query: "vitest", limit: 5, multi: ["brave", "ddg"], scrape: true })).toBe(
      "vitest · limit=5 · multi=brave,ddg · scrape",
    );
    expect(callSummary({ urls: ["a", "b", "c"], max_chars: 100 })).toBe("3 URLs · max_chars=100");
  });

  it("shows a parameter added to a tool later without listing it here", () => {
    expect(callSummary({ query: "q", new_option: 3, other_flag: true, off: false })).toBe(
      "q · new_option=3 · other_flag",
    );
  });

  it("copes with missing arguments while a call streams in, and bounds hostile input", () => {
    expect(callSummary(undefined)).toBe("");
    const summary = callSummary({ query: hostile.repeat(500) });
    expect(summary.length).toBeLessThanOrEqual(260);
    expectNoControls(summary);
  });
});

describe("result cards", () => {
  it("lists the first few search results with their hosts, not page bodies", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.org/${i}`,
      description: "Useful snippet",
      content: "FULL_BODY".repeat(500),
    }));
    const r = await setup(createSearchTool, ok(rows)).run({ query: "q", scrape: true });
    const lines = resultLines(r).join("\n");

    expect(lines).toMatch(/^6 results\n1\. Result 0 · example\.org\n {3}Useful snippet/);
    expect(lines).toMatch(/4\. Result 3 · example\.org/);
    expect(lines).toMatch(/\+2 more$/);
    expect(lines).not.toMatch(/Result 4|FULL_BODY/);
  });

  it("names code matches by repository, path and line", async () => {
    const hit = {
      repo: "o/r",
      path: "main.go",
      line: 42,
      snippet: "func main()",
      url: "https://github.com/o/r",
    };
    const r = await setup(createCodeTool, ok([hit])).run({ query: "main" });

    expect(resultLines(r)).toEqual([
      "1 result",
      "1. o/r/main.go:42 · github.com",
      "   func main()",
    ]);
  });

  it("shows library IDs for resolved docs", async () => {
    const libs = [
      { id: "/vitest-dev/vitest", title: "Vitest", description: "Testing framework" },
      { id: "/websites/vitest_dev", title: "Vitest" },
    ];
    const r = await setup(createDocsTool, ok(libs)).run({ query: "vitest", resolve: true });

    expect(resultLines(r)).toEqual([
      "2 libraries",
      "1. Vitest",
      "   /vitest-dev/vitest",
      "   Testing framework",
      "2. Vitest",
      "   /websites/vitest_dev",
    ]);
  });

  it("shows warnings and strips controls a scraped page carries", async () => {
    const page = { url: "https://example.org/a", title: `Title ${hostile}`, markdown: hostile };
    const r = await setup(
      createScrapeTool,
      ok([page], "warn: HTTP 404 for https://example.org/b\n"),
    ).run({
      urls: ["https://example.org/a", "https://example.org/b"],
    });

    expect(resultLines(r)).toEqual([
      "1 page",
      "1. Title okREDend · example.org",
      "   okREDend",
      "1 warning",
      "   HTTP 404 for https://example.org/b",
    ]);
  });

  it("shows a failure with its message", async () => {
    const r = await setup(createSearchTool, failed(4, "Error: search failed: 503\n")).run({
      query: "q",
    });

    expect(resultLines(r)[0]).toBe("Failed");
    expect(resultLines(r)[1]).toMatch(/^\[upstream\] search failed: 503/);
  });
});

describe("renderers", () => {
  it("keeps full content for the expanded view only, sanitized", async () => {
    // The collapsed card previews the first 150 characters; the marker sits past them.
    const markdown = `Intro ${"x".repeat(200)} EXPANDED_ONLY ${hostile}`;
    const page = { url: "https://example.org/a", title: "A", markdown };
    const r = await setup(createScrapeTool, ok(page)).run({ url: page.url });

    expect(resultLines(r)[2]).toMatch(/^ {3}Intro x+…$/);
    expect(draw(r)).not.toMatch(/EXPANDED_ONLY/);
    expect(draw(r)).toMatch(/Expand tool output for full details/);
    const expanded = draw(r, { expanded: true });
    expect(expanded).toMatch(/EXPANDED_ONLY okREDend/);
    expectNoControls(expanded);
    expect(draw(r, { isPartial: true })).toMatch(/Working…/);
  });

  it("are registered on every tool and leave what the model and scripts get unchanged", async () => {
    const tools: ToolDefinition[] = [];
    const stdout = JSON.stringify([{ title: "T", url: "https://example.org", description: "d" }]);
    ketch({
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      exec: async () => ({ stdout, stderr: "", code: 0, killed: false }),
    } as unknown as ExtensionAPI);

    expect(tools.map((t) => t.name)).toEqual([
      "ketch_search",
      "ketch_code",
      "ketch_docs",
      "ketch_scrape",
    ]);
    for (const tool of tools) {
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
    }
    const r = (await tools[0].execute(
      "call",
      { query: "q" },
      undefined,
      undefined,
      {} as never,
    )) as KetchResult;
    const before = JSON.stringify(r);
    tools[0].renderResult!(r, { expanded: true, isPartial: false }, theme, {} as never).render(80);
    expect(JSON.stringify(r)).toBe(before);
  });
});
