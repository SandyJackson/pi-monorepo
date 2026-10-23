import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createScrapeTool } from "./scrape.ts";
import { failed, ok, setup as setupTool, text } from "./test-support.ts";

const setup = (result: Parameters<typeof setupTool>[1]) => setupTool(createScrapeTool, result);

const page = { url: "https://example.com/a", title: "Page A", markdown: "# A\n\nBody." };

describe("ketch_scrape", () => {
  it("fetches one URL with the default page cap and returns markdown and pages", async () => {
    const { run, argv, conforms } = setup(ok(page));
    const r = await run({ url: "https://example.com/a" });

    expect(argv()).toEqual([
      "scrape",
      "--json",
      "--max-chars=6000",
      "--",
      '["https://example.com/a"]',
    ]);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("## [Page A](https://example.com/a)\n\n# A\n\nBody.");
    expect(r.structuredContent).toEqual({ pages: [page] });
    expect(conforms(r)).toBe(true);
  });

  it("numbers batch pages and reports per-URL failures from stderr as warnings", async () => {
    const other = { url: "https://example.com/b", markdown: "B body" };
    const { run, argv, conforms } = setup(
      ok([page, other], "warn: HTTP 404 for https://example.com/c\n"),
    );
    const r = await run({
      urls: ["https://example.com/a", " https://example.com/b ", "https://example.com/c"],
    });

    expect(argv()?.at(-1)).toBe(
      '["https://example.com/a","https://example.com/b","https://example.com/c"]',
    );
    expect(text(r)).toBe(
      "## [1. Page A](https://example.com/a)\n\n# A\n\nBody.\n\n" +
        "## [2. https://example.com/b](https://example.com/b)\n\nB body\n\n" +
        "Warnings:\n- HTTP 404 for https://example.com/c",
    );
    expect(r.structuredContent).toEqual({
      pages: [page, other],
      warnings: ["HTTP 404 for https://example.com/c"],
    });
    expect(conforms(r)).toBe(true);
  });

  it("binds flag values with = and keeps a dash-leading URL after --", async () => {
    const { run, argv } = setup(ok(page));
    await run({ url: "--help", selector: "-main", max_chars: 100, no_cache: true });

    expect(argv()).toEqual([
      "scrape",
      "--json",
      "--select=-main",
      "--max-chars=100",
      "--no-cache",
      "--",
      '["--help"]',
    ]);
  });

  it.each([
    [{}, "give url or urls"],
    [{ urls: [" "] }, "give url or urls"],
    [{ url: "https://a.example", urls: ["https://b.example"] }, "give url or urls, not both"],
  ])("rejects %j without running ketch", async (params, message) => {
    const { exec, run, conforms } = setup(ok(page));
    const r = await run(params);

    expect(exec).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ error: { kind: "validation", message } });
    expect(conforms(r)).toBe(true);
  });

  it.each([
    [2, "validation", "fix the input"],
    [3, "not_found", "no such resource"],
    [4, "upstream", "retrying may help"],
    [5, "precondition", "tell the user"],
    [6, "cancelled", "ran out of time"],
    [1, "upstream", "retrying may help"],
  ])("maps exit code %i to %s and explains it", async (code, kind, meaning) => {
    const { run, conforms } = setup(failed(code, "Error: scrape failed: boom\n"));
    const r = await run({ url: "https://example.com/a" });

    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(new RegExp(`^\\[${kind}\\] scrape failed: boom \\(.*${meaning}`));
    expect(r.structuredContent).toEqual({ error: { kind, message: "scrape failed: boom" } });
    expect(conforms(r)).toBe(true);
  });

  it("reports a missing binary as a precondition", async () => {
    const enoent = Object.assign(new Error("spawn ketch ENOENT"), { code: "ENOENT" });
    for (const exec of [
      async () => Promise.reject(enoent),
      async () => failed(1, ""), // pi.exec swallows the spawn error
    ]) {
      const r = await setup(exec).run({ url: "https://example.com/a" });
      expect(r.structuredContent).toMatchObject({ error: { kind: "precondition" } });
    }
  });

  it("reports a killed process as cancelled", async () => {
    const { run } = setup({ stdout: "", stderr: "", code: 1, killed: true });
    const r = await run({ url: "https://example.com/a" });

    expect(r.structuredContent).toEqual({
      error: { kind: "cancelled", message: "ketch scrape: the call exceeded its 120s budget" },
    });
  });

  it("treats output that isn't JSON as an upstream error", async () => {
    const { run } = setup({ stdout: "<html>", stderr: "", code: 0, killed: false });
    const r = await run({ url: "https://example.com/a" });

    expect(r.structuredContent).toMatchObject({ error: { kind: "upstream" } });
  });

  it("treats a null payload as no pages", async () => {
    const { run, conforms } = setup(ok(null));
    const r = await run({ url: "https://example.com/a" });

    expect(text(r)).toBe("No pages were fetched.");
    expect(r.structuredContent).toEqual({ pages: [] });
    expect(conforms(r)).toBe(true);
  });

  it("truncates oversized output and spills the full text to a file", async () => {
    const big = { url: "https://example.com/big", markdown: "line\n".repeat(30_000) };
    const { run } = setup(ok(big));
    const r = await run({ url: big.url });
    const path = r.details.fullOutputPath!;
    try {
      expect(text(r)).toMatch(/\[Output truncated: showing .* Full output: .*output\.md\]$/);
      expect(text(r).length).toBeLessThan(60_000);
      expect(readFileSync(path, "utf8")).toContain(big.markdown);
      expect(r.structuredContent).toEqual({ pages: [big] });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});
