import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { flag, positional, toggle } from "./args.ts";
import { defined, heading, items, str, strs } from "./fields.ts";
import { renderers } from "./render.ts";
import {
  DEFAULT_MAX_CHARS,
  ErrorOutput,
  errorResult,
  type KetchDetails,
  type Rendered,
  runJson,
} from "./result.ts";
import type { Exec } from "./runner.ts";

const TIMEOUT_MS = 120_000;
// Backend names join into one comma-separated flag value, so they can't contain commas.
const BACKEND_NAME = /^[a-z0-9_-]+$/i;

const SearchParams = Type.Object({
  query: Type.String({ description: "The search query." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results." })),
  multi: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description:
        'Backends to query together and rank-fuse, e.g. ["brave","ddg"], or ["all"]. ' +
        "Only to corroborate a contested question; omit it for routine searches.",
    }),
  ),
  scrape: Type.Optional(
    Type.Boolean({ description: "Also fetch each result and include the start of its page." }),
  ),
  max_chars: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20_000,
      description: `Characters kept per fetched page with scrape (default ${DEFAULT_MAX_CHARS}).`,
    }),
  ),
});

type SearchInput = Static<typeof SearchParams>;

const SearchResult = Type.Object({
  title: Type.String(),
  url: Type.String(),
  description: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  backends: Type.Optional(Type.Array(Type.String())),
});

const SearchOutput = Type.Object({
  results: Type.Array(SearchResult),
  warnings: Type.Optional(Type.Array(Type.String())),
});

type SearchResult = Static<typeof SearchResult>;

function searchArgs(p: SearchInput): string[] {
  const args = ["search", "--json"];
  flag(args, "--limit", p.limit);
  if (p.multi) args.push(`--multi=${p.multi.join(",")}`);
  toggle(args, "--scrape", p.scrape);
  if (p.scrape) flag(args, "--max-chars", p.max_chars ?? DEFAULT_MAX_CHARS);
  return positional(args, p.query);
}

export function createSearchTool(exec: Exec): ToolDefinition<typeof SearchParams, KetchDetails> {
  return {
    name: "ketch_search",
    label: "ketch search",
    ...renderers<typeof SearchParams>("search"),
    description:
      "Search the web with the operator's default backend. With scrape, each result includes " +
      `the first ${DEFAULT_MAX_CHARS} characters of its page unless max_chars says otherwise.`,
    promptSnippet: "Search the open web",
    parameters: SearchParams,
    outputSchema: Type.Union([SearchOutput, ErrorOutput]),
    async execute(_id, p, signal) {
      if (!p.query.trim()) return errorResult("validation", "query is empty");
      const bad = p.multi?.find((name) => !BACKEND_NAME.test(name));
      if (bad !== undefined) return errorResult("validation", `"${bad}" is not a backend name`);
      return runJson(exec, searchArgs(p), signal, TIMEOUT_MS, render);
    },
  };
}

function render(json: unknown): Rendered {
  const results = items(json).map(
    (raw): SearchResult =>
      defined({
        title: str(raw, "title") ?? str(raw, "url") ?? "",
        url: str(raw, "url") ?? "",
        description: decodeEntities(str(raw, "description")),
        content: str(raw, "content"),
        backends: strs(raw, "backends"),
      }),
  );
  if (results.length === 0) return { text: "No results.", output: { results } };
  const text = results
    .map((r, i) =>
      [
        heading(r.title, r.url, i, results.length),
        r.backends && `Backends: ${r.backends.join(", ")}`,
        r.description && `\n${r.description}`,
        r.content && `\n${r.content}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return { text, output: { results } };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Search engines return HTML-escaped snippets, such as `&#x27;` for an apostrophe. */
function decodeEntities(text: string | undefined): string | undefined {
  return text?.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? match;
    const code =
      ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : match;
  });
}
