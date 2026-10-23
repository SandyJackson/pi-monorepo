import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { flag, positional, toggle } from "./args.ts";
import { defined, heading, int, items, str } from "./fields.ts";
import { renderers } from "./render.ts";
import { ErrorOutput, errorResult, type KetchDetails, type Rendered, runJson } from "./result.ts";
import type { Exec } from "./runner.ts";

const TIMEOUT_MS = 60_000;

const CodeParams = Type.Object({
  query: Type.String({ description: "Text or regular expression to find in public code." }),
  repo: Type.Optional(Type.String({ description: "Search one repository, as owner/name." })),
  lang: Type.Optional(Type.String({ description: "Language filter, such as typescript." })),
  regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results." })),
});

type CodeInput = Static<typeof CodeParams>;

const CodeResult = Type.Object({
  repo: Type.String(),
  path: Type.String(),
  line: Type.Optional(Type.Integer()),
  snippet: Type.String(),
  url: Type.String(),
  language: Type.Optional(Type.String()),
});

const CodeOutput = Type.Object({
  results: Type.Array(CodeResult),
  warnings: Type.Optional(Type.Array(Type.String())),
});

type CodeResult = Static<typeof CodeResult>;

function codeArgs(p: CodeInput): string[] {
  const args = ["code", "--json"];
  flag(args, "--repo", p.repo);
  flag(args, "--lang", p.lang);
  toggle(args, "--regex", p.regex);
  flag(args, "--limit", p.limit);
  return positional(args, p.query);
}

export function createCodeTool(exec: Exec): ToolDefinition<typeof CodeParams, KetchDetails> {
  return {
    name: "ketch_code",
    label: "ketch code",
    ...renderers<typeof CodeParams>("code"),
    description: "Search public open-source code to see how real projects use an API.",
    promptSnippet: "Find real-world usage in public code",
    parameters: CodeParams,
    outputSchema: Type.Union([CodeOutput, ErrorOutput]),
    async execute(_id, p, signal) {
      if (!p.query.trim()) return errorResult("validation", "query is empty");
      return runJson(exec, codeArgs(p), signal, TIMEOUT_MS, render);
    },
  };
}

function render(json: unknown): Rendered {
  const results = items(json).map(
    (raw): CodeResult =>
      defined({
        repo: str(raw, "repo") ?? "",
        path: str(raw, "path") ?? "",
        line: int(raw, "line"),
        snippet: str(raw, "snippet") ?? "",
        url: str(raw, "url") ?? "",
        language: str(raw, "language"),
      }),
  );
  if (results.length === 0) return { text: "No results.", output: { results } };
  const text = results
    .map((r, i) => {
      const where = `${r.repo}/${r.path}${r.line ? `:${r.line}` : ""}`;
      return `${heading(where, r.url, i, results.length)}\n\n\`\`\`${r.language ?? ""}\n${r.snippet}\n\`\`\``;
    })
    .join("\n\n");
  return { text, output: { results } };
}
