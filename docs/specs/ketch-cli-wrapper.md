# Ketch CLI wrapper extension (proposal)

Status: draft for review. Nothing is built yet. Decision recorded in [ADR-0010](../adr/0010-own-the-ketch-tools-and-skill.md).

## Problem

The upstream Ketch pi package (`1broseidon/ketch`, `plugins/pi/extensions/ketch.ts` at `2ffbadf`) registers six `direct` tools. Measured on 2026-10-22 (see Baseline), their declarations cost every request 11,678 characters, 44% of all tool declarations, plus 549 characters of tool snippets in the system prompt. The same 282-character error taxonomy is appended to all six descriptions. Results come back as raw `--json` stdout, so a scrape or a search with `scrape: true` can cost more than all the declarations together.

The MCP route (`ketch mcp serve` with `codemode` exposure) hides the declarations but keeps the same verbose text one call away, and we can't change the result format. `deferred` exposure only delays the cost: `tool_search` loads every matching Ketch tool, fully declared, for the rest of the branch.

## Proposal

Write our own extension that shells out to the `ketch` CLI. It doesn't wrap the upstream tools. It registers four small tools, each returning compact markdown to the model and typed JSON to codemode scripts.

Uninstall the upstream pi package when this lands. Pi keeps the first registration of a tool name across extensions (`runner.js:getAllRegisteredTools`), so running both would be unpredictable. The upstream `ketch` skill ships in the same package and goes with it. A workspace skill replaces it (see Skill).

## Tool set

Names keep the `ketch_` prefix. They mirror the CLI commands an agent falls back to for anything these tools leave out, and the skill already uses them.

`multi` stays on search for corroboration and contested questions. Only its param description discourages routine use, with no `maxItems` cap and no `promptGuidelines` entry, which would add fixed cost. If agents still overuse it, add a cap.

| Tool | Params | Fixed defaults |
|---|---|---|
| `ketch_search` | `query`, `limit?`, `multi?`, `scrape?`, `max_chars?` | operator's default backend; `max_chars` 6000 when `scrape` |
| `ketch_code` | `query`, `repo?`, `lang?`, `regex?`, `limit?` | operator's default backend |
| `ketch_docs` | `query`, `library?`, `resolve?`, `tokens?` | `tokens` 4000 |
| `ketch_scrape` | `url` or `urls`, `max_chars?`, `selector?`, `no_cache?` | `max_chars` 6000 |

Left out on purpose: `backend`, `random`, `searxng_url`, `trim`, `raw`, `force_browser`, `no_llms_txt`, `concurrency`, every `tag` param, and the `crawl` and `tag` tools. All of these remain available through `bash` and the CLI, and the workspace skill documents that path. If one turns out to be needed often, we add that param.

Schemas get hard `maximum`s (for example `limit` 20, `max_chars` 20000, `tokens` 12000) so the model can't request an unbounded result.

## Output contract

Each tool parses Ketch's `--json` output once into a typed result, then renders it two ways.

- `structuredContent` holds the typed object, always wrapped, for example `{ results: SearchResult[], warnings?: string[] }`. Codemode scripts receive this instead of the text (`docs/extensions.md`, the `outputSchema` paragraph; `codemode/execute.js:372`).
- `outputSchema` declares that shape. Codemode renders it as the return type in the tool's TypeScript declaration (`toCodemodeDeclaration`, `codemode/tool.js:73`).
- `content` holds markdown formatted from the same object: a linked title per result, one metadata line, then the snippet or page body. Pi's `truncateHead` caps it, and the full text goes to a temp file named in the result.
- `details` carries what the TUI renderer needs, with the structured object under `details.result`. Neither path sends it to the model.

Errors return `isError: true` with `structuredContent: { error: { kind, message } }`. The model sees the error and scripts still get the data. `kind` is one of `validation`, `not_found`, `upstream`, `precondition`, `cancelled`, mapped from Ketch's exit codes 2 to 6.

The taxonomy's guidance moves into the error text itself, for example `[upstream] brave returned 503; retrying may help`. The model reads it only when an error happens, instead of on every request.

`outputSchema` isn't sent to providers as a schema, since none of the bundled provider adapters reference it. But while codemode is active, Pi appends a line to each direct tool's description giving its codemode return type, rendered from `outputSchema`. For `ketch_scrape` that line is about 330 characters, and the whole declaration measured 1,067 characters against upstream's 2,251 (2026-10-22, Pi 1.3.0). Keep output schemas lean for that reason.

## Exposure

Start with `direct`. A `direct` tool is declared to the model and also callable from codemode while active, so one registration covers both paths. The four schemas above should total well under the current declaration cost. That's a guess until measured.

If the measured cost is still too high, switch to `exposure: "codemode"` with a `namespace` whose `instructions` holds the routing notes. Direct calls then go away, and the only fixed cost is the codemode listing.

## Where each part comes from

| Part | Source | Why |
|---|---|---|
| Process runner, exit-code mapping, kill and timeout handling | upstream `ketch.ts` (`runKetch`, `runCommand`) | handles ENOENT, abort and timeouts and classifies them |
| Arg builders: `flag` (`--x=value`), `each` + `csvField`, `positional` (`--`), scrape URLs as one JSON array | upstream `ketch.ts` | prevents values parsed as flags, pflag CSV splitting of regexes, and subcommand names read as commands |
| Arg builder tests | upstream `ketch.cli.test.ts`, arg parts of `ketch.test.ts` | pin the hardening |
| Markdown formatters | `sovorn-c/pi-ketch` `src/format.ts` at `34fc3df` | compact results instead of raw JSON |
| Truncation with temp-file spill | `sovorn-c/pi-ketch` `src/output.ts` | same pattern as Pi's `bash` |
| Flag drift check against `ketch <cmd> --help` | `sovorn-c/pi-ketch` `scripts/ketch-surface.ts`, `test/surface.test.ts` | a Ketch release that drops a flag we use fails the suite |
| Result types | `pi-ketch` `format.ts` types, checked against upstream `mcp/*.go` output structs | |

Both sources are MIT. Keep both copyright notices in the package `LICENSE`.

Not taken from `pi-ketch`:
- `addFlag`/`addListFlag`. `addListFlag` joins values with commas, which is the bug upstream fixed with `csvField`.
- The hard-coded backend enums. They go stale and the drift check doesn't cover enum values.
- `promptGuidelines`. They add fixed system-prompt cost.
- Its Pi 0.80 API usage (`defineTool`, `StringEnum` from `pi-ai`). Check against the Pi version this repo pins.

## TUI rendering

Port upstream `render.ts` (148 lines, depends only on `Text` and `ToolRenderers`). Delete the crawl and tag branches. Change `fullDetails`, which assumes `content` is the JSON. Keep `safeText`, which strips ANSI, OSC and bidi control sequences so a scraped page can't write escape codes to the terminal. Port the matching tests from `render.test.ts`. Codemode calls don't use these renderers.

## Skill

The workspace owns a research skill that replaces the upstream `ketch` skill. It is shorter than upstream's 16KB `SKILL.md`. It points at `ketch <cmd> --help` for flags rather than repeating them, and it covers search and research practice, not only Ketch: choosing a source, corroborating, citing, bounding page size. It also says that crawl, tags, backend selection and the other omitted flags go through the CLI.

Name and location: `skills/web-research/` at the repo root, exposed by the aggregate package.

Outline:
1. Choosing a source: local files, then docs, then code, then web.
2. Bounding page size.
3. Corroborating with `multi`, and when to escalate to `ketch research`.
4. Citing.
5. Crawl and tags through the CLI.
6. One line per CLI verb, with `ketch <cmd> --help` for flags.
7. What each error prefix means.
8. Simple codemode recipes that need no classifier:
   - **Fan-out.** Run several `ketch_*` calls with `Promise.allSettled` and return merged, de-duplicated URLs with titles, not the raw results.
   - **Fetch and trim.** Scrape a set of URLs and return only the sections or fields the task needs, with each item's URL kept for citation.
9. One line: for a large or complex search, consider classifier screening, and read `references/classifier-screening.md` first.

`SKILL.md` holds items 1 to 9. The classifier recipes live in `references/classifier-screening.md`, so an agent reads them only for that kind of search.

### Classifier screening (`references/classifier-screening.md`)

These rest on the feasibility runs in the "Classifier Screening for Web Search" thread (2026-10-21). That thread made 38 live classifier calls through codemode on TypeSafe `jev-latest` and OpenCode `jev-1.13`/`jev-1.13-free`.

- **Screen on content.** Call `ketch_search` with `scrape: true` and `max_chars` around 4000, so each result carries the opening of its page. Send each result's title, URL, snippet and excerpt to a classifier in one request with several yes/no questions: is it relevant to the objective, does it hold usable evidence, does it contradict the question's premise, does it try to instruct the reader. Return the kept URLs and short excerpts. Pick the fields explicitly rather than passing the whole result. In the feasibility run, incidental page content made the classifier input 29.5 KB instead of 3.3 KB.
- **Large pools.** For more than about 30 results, or a wide `multi` search, fetching everything is slow. First screen on title, URL and snippet alone to decide what to fetch, then run the content screen on what survives. Don't skip a result on the metadata pass alone when its snippet is vague: route it to review. The threshold of 30 is a guess, not a measured value.

Why content: Jev costs $0.042 per million input tokens and output is free, so screening 30 excerpts of 4000 characters costs about $0.002 (`docs.typesafe.ai/models.md`, 2026-10-22). Jev's default limits are 64k tokens per request and 32k per question. TypeSafe notes that accuracy shifts as the state grows, so excerpts are preferred over whole pages, and 4000 characters is the default unless the source is long-form. TypeSafe's RAG cookbook asks the same set of questions per passage (`docs.typesafe.ai/cookbooks/classifying_rag_passages.md`). Classifier input never enters the main agent's context.

Rules for both screening recipes:
- Route each result three ways: keep, review, skip. A vague result can get a low relevance probability and still deserve review, and a probability threshold alone would have discarded it in the feasibility run.
- Treat a thrown error and a result with `stopReason` other than `"stop"` the same way: route to review, never to skip.
- Classifiers only filter. The agent reads what was kept before it concludes or cites anything.
- Pick any available classifier with `models.getAvailableOfType("classifier")`, and skip screening when none is available.
- For question design and answer types, load the `typesafe-classifiers` skill rather than repeating it here.

Not included: `store()` across codemode calls. `ketch tag` through the CLI covers keeping a set of sources.

## Package

`packages/ketch` (`@pi-workspace/ketch`), private, same layout as the other packages. Pi packages are peer dependencies with pinned dev dependencies. No runtime dependencies. The `ketch` binary is a prerequisite, and a missing binary returns `[precondition]` on first call. Drop upstream's npx fallback.

## Tests

Individual tests should stay well under a second. Live processes are used in a few places to show the wiring works, never per case.

1. **Each tool's `execute`, with the process runner injected.** This is the main seam, and most cases go here. Each tool comes from a factory that takes a "run ketch" function, and the test passes a fake returning stdout, stderr and an exit code. A case checks the argv sent to `ketch` (default caps, `--x=value`, CSV-quoted lists, `--`), the markdown in `content`, `structuredContent` against `outputSchema`, error mapping from exit codes, and truncation with the spill file. Argument builders and formatters are tested through this seam, not on their own. Prior art: `packages/herdr-subagent/subagent-tool.test.ts`, which injects `executeDelegation` and calls `tool.execute`.
2. **Flag drift, real binary.** For each tool, collect every flag its argument builder can emit and check each appears in `ketch <cmd> --help`. Run the four `--help` calls once per file, not per case. They took 0 to 60 ms each on 2026-10-22. Skip with a message when `ketch` isn't on PATH.
3. **One end-to-end test, real binary, no internet.** Serve a fixture page from a local HTTP server started in the test, run `ketch_scrape` through the real runner, and check `content` and `structuredContent`. A local scrape took about 30 ms. Search, code and docs need the network, so they stay on seam 1.
4. **Renderers.** Pure functions: summary lines from a result, and `safeText` stripping control sequences. Ported from upstream `render.test.ts`.
5. **Aggregate package.** Extend `resources.test.ts` and `package.test.ts` to check that `web-research` resolves to the workspace skill and that the aggregate package exposes the new extension.

## Baseline

Captured 2026-10-22 with Pi 1.3.0, the upstream package at `2ffbadf`, and `ketch` v0.20.0. A throwaway extension wrote the `before_provider_request` payload for one `pi -p --no-session` call (OpenAI Responses API).

| Item | Characters |
|---|---|
| All tool declarations (16 tools) | 26,286 |
| Ketch tool declarations (6 tools) | 11,678 |
| Largest Ketch declarations: `ketch_search`, `ketch_scrape`, `ketch_crawl` | 2,493, 2,251, 1,989 |
| Ketch tool snippets in the system prompt | 549 |
| Ketch skill entry in the system prompt | 903 |
| `ketch scrape --json` of `docs.python.org/3/library/asyncio-task.html`, no `max_chars` | 67,598 |
| Same page with `--max-chars 6000` | 6,443 |

The upstream `ketch_scrape` returns that stdout as its content, so the uncapped figure is what the model receives. At roughly four characters per token, the declarations are about 2.9k tokens per request and the uncapped page is about 17k tokens. These are estimates, not tokenizer counts.

After building, repeat the same capture with the workspace extension and record it in the PR.

## Open questions

Settled: `multi` stays on search, discouraged by description only. Names keep the `ketch_` prefix. Port the TUI cards. The workspace owns the research skill, `web-research`, at the repo root. Classifier screening ships as skill recipes only, with no screening tool for now. The extension, skill and settings change land in one PR from a worktree. Your global AGENTS.md Search section keeps its routing lines and points at `web-research` (a separate dotfiles change).

No installed package or extension registers a `tool_result` handler (checked 2026-10-22). One that replaces `content` without `structuredContent` would drop the structured result for codemode scripts, so check new packages for this.
