import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { flag, positional, toggle } from "./args.ts";
import {
  ErrorOutput,
  errorResult,
  type KetchDetails,
  successResult,
  warningsBlock,
} from "./result.ts";
import { type Exec, runKetch, warningsOf } from "./runner.ts";

const DEFAULT_MAX_CHARS = 6000;
const MAX_URLS = 20;
const TIMEOUT_MS = 120_000;

const ScrapeParams = Type.Object({
  url: Type.Optional(Type.String({ description: "One URL to fetch. Give url or urls, not both." })),
  urls: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      maxItems: MAX_URLS,
      description: "Several URLs to fetch at once. Give url or urls, not both.",
    }),
  ),
  max_chars: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20_000,
      description: `Characters kept per page (default ${DEFAULT_MAX_CHARS}).`,
    }),
  ),
  selector: Type.Optional(
    Type.String({ description: "CSS selector to extract instead of the main content." }),
  ),
  no_cache: Type.Optional(Type.Boolean({ description: "Bypass the page cache." })),
});

type ScrapeInput = Static<typeof ScrapeParams>;

const ScrapePage = Type.Object({
  url: Type.String(),
  title: Type.Optional(Type.String()),
  markdown: Type.String(),
});

const ScrapeOutput = Type.Object({
  pages: Type.Array(ScrapePage),
  warnings: Type.Optional(Type.Array(Type.String())),
});

type ScrapePage = Static<typeof ScrapePage>;
type ScrapeOutput = Static<typeof ScrapeOutput>;

/**
 * The URLs always travel as one JSON-array argument: the CLI reads a lone
 * positional that names an existing path as a file of URLs, whereas each entry
 * of a JSON array is taken as a URL.
 */
function scrapeArgs(p: ScrapeInput, urls: string[]): string[] {
  const args = ["scrape", "--json"];
  flag(args, "--select", p.selector);
  flag(args, "--max-chars", p.max_chars ?? DEFAULT_MAX_CHARS);
  toggle(args, "--no-cache", p.no_cache);
  return positional(args, JSON.stringify(urls));
}

export function createScrapeTool(exec: Exec): ToolDefinition<typeof ScrapeParams, KetchDetails> {
  return {
    name: "ketch_scrape",
    label: "ketch scrape",
    description:
      `Fetch URLs as markdown, ${DEFAULT_MAX_CHARS} characters per page unless max_chars says otherwise. ` +
      "For crawls, raw HTML or a headless browser, run the ketch CLI with bash.",
    promptSnippet: "ketch_scrape to read a page when you already have its URL",
    parameters: ScrapeParams,
    outputSchema: Type.Union([ScrapeOutput, ErrorOutput]),
    async execute(_id, p, signal) {
      const single = p.url?.trim();
      const batch = (p.urls ?? []).map((u) => u.trim()).filter(Boolean);
      if (!single && batch.length === 0) return errorResult("validation", "give url or urls");
      if (single && batch.length > 0) {
        return errorResult("validation", "give url or urls, not both");
      }
      const r = await runKetch(exec, scrapeArgs(p, single ? [single] : batch), signal, TIMEOUT_MS);
      if (!r.ok) return errorResult(r.kind, r.message);

      const pages = parsePages(r.stdout);
      if (!pages) return errorResult("upstream", "ketch scrape returned output that isn't JSON");
      const warnings = warningsOf(r.stderr);
      const output: ScrapeOutput = warnings.length > 0 ? { pages, warnings } : { pages };
      return successResult(formatPages(pages) + warningsBlock(warnings), output);
    },
  };
}

/** One URL prints an object, several print an array. */
function parsePages(stdout: string): ScrapePage[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const page: ScrapePage = {
      url: String(raw.url ?? ""),
      markdown: typeof raw.markdown === "string" ? raw.markdown : "",
    };
    if (typeof raw.title === "string" && raw.title) page.title = raw.title;
    return page;
  });
}

function formatPages(pages: ScrapePage[]): string {
  if (pages.length === 0) return "No pages were fetched.";
  return pages
    .map((page, i) => {
      const label = page.title ?? page.url;
      const heading = pages.length > 1 ? `${i + 1}. ${label}` : label;
      return `## [${heading}](${page.url})\n\n${page.markdown}`;
    })
    .join("\n\n");
}
