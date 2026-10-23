import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { flag, positional, toggle } from "./args.ts";
import { defined, heading, int, items, str, strs } from "./fields.ts";
import { renderers } from "./render.ts";
import { ErrorOutput, errorResult, type KetchDetails, type Rendered, runJson } from "./result.ts";
import type { Exec } from "./runner.ts";

const TIMEOUT_MS = 60_000;
// Resolve lists many versions; a few are enough to pick one.
const VERSIONS_SHOWN = 8;

const DocsParams = Type.Object({
  query: Type.String({
    description: "What to look up, or a library name to resolve when resolve is set.",
  }),
  resolve: Type.Optional(
    Type.Boolean({ description: "Find library IDs for a library name instead of searching." }),
  ),
  library: Type.Optional(
    Type.String({ description: "Library ID from resolve, to search that library's docs." }),
  ),
  tokens: Type.Optional(
    Type.Integer({
      minimum: 100,
      maximum: 12_000,
      description: "Token budget with library (default 4000).",
    }),
  ),
});

type DocsInput = Static<typeof DocsParams>;

const DocsResult = Type.Object({
  library: Type.String(),
  title: Type.String(),
  snippet: Type.String(),
  url: Type.Optional(Type.String()),
});

const Library = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  versions: Type.Optional(Type.Array(Type.String())),
  snippets: Type.Optional(Type.Integer()),
});

const Warnings = Type.Optional(Type.Array(Type.String()));

const DocsOutput = Type.Object({ results: Type.Array(DocsResult), warnings: Warnings });
const ResolveOutput = Type.Object({ libraries: Type.Array(Library), warnings: Warnings });

type DocsResult = Static<typeof DocsResult>;
type Library = Static<typeof Library>;

function docsArgs(p: DocsInput): string[] {
  const args = ["docs", "--json"];
  toggle(args, "--resolve", p.resolve);
  flag(args, "--library", p.library);
  flag(args, "--tokens", p.tokens);
  return positional(args, p.query);
}

export function createDocsTool(exec: Exec): ToolDefinition<typeof DocsParams, KetchDetails> {
  return {
    name: "ketch_docs",
    label: "ketch docs",
    ...renderers<typeof DocsParams>("docs"),
    description:
      "Search a library's own documentation. Resolve the library name to an ID first, " +
      "then search with library set to that ID.",
    promptSnippet: "Read a library's own documentation",
    parameters: DocsParams,
    outputSchema: Type.Union([DocsOutput, ResolveOutput, ErrorOutput]),
    async execute(_id, p, signal) {
      if (!p.query.trim()) return errorResult("validation", "query is empty");
      if (p.resolve && p.library) {
        return errorResult("validation", "resolve finds a library ID; don't pass library with it");
      }
      return runJson(exec, docsArgs(p), signal, TIMEOUT_MS, p.resolve ? renderLibraries : render);
    },
  };
}

function render(json: unknown): Rendered {
  const results = items(json).map(
    (raw): DocsResult =>
      defined({
        library: str(raw, "library") ?? "",
        title: str(raw, "title") ?? "",
        snippet: str(raw, "snippet") ?? "",
        url: str(raw, "url"),
      }),
  );
  if (results.length === 0) return { text: "No results.", output: { results } };
  const text = results
    .map(
      (r, i) =>
        `${heading(r.title || r.library, r.url, i, results.length)}\nLibrary: ${r.library}\n\n${r.snippet}`,
    )
    .join("\n\n");
  return { text, output: { results } };
}

function renderLibraries(json: unknown): Rendered {
  const libraries = items(json).map(
    (raw): Library =>
      defined({
        id: str(raw, "id") ?? "",
        title: str(raw, "title") ?? "",
        description: str(raw, "description"),
        versions: strs(raw, "versions")?.slice(0, VERSIONS_SHOWN),
        snippets: int(raw, "totalSnippets"),
      }),
  );
  if (libraries.length === 0) return { text: "No libraries matched.", output: { libraries } };
  const text = libraries
    .map((l, i) =>
      [
        heading(l.title || l.id, undefined, i, libraries.length),
        `Library ID: ${l.id}`,
        l.snippets !== undefined && `${l.snippets} snippets`,
        l.versions && `Versions: ${l.versions.join(", ")}`,
        l.description,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return { text, output: { libraries } };
}
