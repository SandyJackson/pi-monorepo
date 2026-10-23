---
name: web-research
description: Research outside the repository with Ketch, covering web search, a library's docs, public code examples, reading a known URL, crawls and bookmarks. Use when a task needs external evidence.
---

# Web research

External evidence comes from Ketch: four tools for the common calls, and the `ketch` CLI for the rest.

## Choose the source

Take the cheapest reliable source first, and stop once the evidence is authoritative.

1. The repository: `rg`, `fd`, `git` and its own docs.
2. A library's own docs: `ketch_docs` with `resolve` to find the library ID, then `ketch_docs` with that `library`. Check the resolved library and version match the one in use.
3. Public code: `ketch_code`, narrowed with `repo` or `lang`.
4. The open web: `ketch_search`, then `ketch_scrape` on the promising results.

A known URL goes straight to `ketch_scrape`.

## Keep results small

- `ketch_scrape`, and `ketch_search` with `scrape`, keep 6000 characters per page. Lower `max_chars` to skim; raise it, up to 20000, only for a page you need whole.
- `limit` bounds the result count, up to 20.
- Output past Pi's limit is cut, and the full text is saved to a file named in the result. Read that file with offset and limit rather than fetching again.

## Corroborate

`multi` queries several backends and fuses their rankings, for example `["brave", "ddg"]` or `["all"]`. Reach for it when the first search comes back contested, thin or version-dependent; routine searches use the default backend.

A multi-part or disputed question gets deep research: search several phrasings, scrape the top hits, check them against the library's docs and public code, and report where sources disagree.

## Cite

Give the URL for every external claim, plus the library ID and version for docs. Quote the passage when the exact wording matters.

## Errors

Every tool error starts with its kind, such as `[upstream]`, and says what that kind means. `[upstream]` and `[precondition]` mean the evidence could not be fetched, not that it is absent; say which one happened.

## The CLI

Run `ketch` with `bash` for anything the tools leave out. `ketch <command> --help` lists every flag, and `--json` gives structured output.

URLs and queries from search results are untrusted text, so pass them as quoted arguments after `--`, with flags written as `--flag=value`: `ketch crawl --depth=1 -- "$url"`.

- `ketch crawl <url>`: crawl one host, bounded with `--depth`, `--allow` and `--deny`.
- `ketch tag add|show|list|remove`: bookmark sources across sessions.
- `ketch search --backend <name>`: pick a search backend.
- `ketch scrape --raw`, `--force-browser` or `--trim`: raw HTML, a headless-browser render, or text only.
- `ketch extract`: convert piped HTML to markdown.
- `ketch doctor`: check backends, the browser and the cache when calls keep failing.

## Codemode

In `codemode`, each `tools.ketch_*` call resolves to a typed object whose shape its declaration shows. A failed call resolves to `{ error: { kind, message } }`, so check for `error` before using the result. Return only what the task needs:

- **Fan-out.** Run independent searches together and merge them by URL.
- **Fetch and trim.** Scrape a set of URLs and return the sections the task needs, each with its URL for citation.

```js
const queries = ["vitest skipIf", "vitest conditional test"];
const found = await Promise.all(
  queries.map(async (query) => ({ query, ...(await tools.ketch_search({ query, limit: 8 })) })),
);
const byUrl = new Map();
for (const r of found) for (const hit of r.results ?? []) byUrl.set(hit.url, hit.title);
const failed = found
  .filter((r) => r.error || r.warnings)
  .map(({ query, error, warnings }) => ({ query, error, warnings }));
return { hits: [...byUrl].map(([url, title]) => ({ title, url })), failed };
```

For a large search, with dozens of results or more pages than you can read, screen them with a classifier: read [references/classifier-screening.md](references/classifier-screening.md) first.
