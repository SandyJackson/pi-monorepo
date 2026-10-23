---
status: accepted
---

# Own the Ketch tools and research skill

We replace the upstream Ketch pi package (`git:github.com/1broseidon/ketch`) with a workspace extension package that shells out to the `ketch` CLI, plus a workspace-owned research skill. The upstream package declares six tools on every request, about 11.7k characters of the 26.3k tool declarations measured on 2026-10-22, and returns raw CLI JSON, so an uncapped scrape of one long page is about 68k characters. Our package declares four tools with small schemas and default size caps. Each tool returns compact markdown to the model and typed `structuredContent` to codemode scripts. See [the spec](../specs/ketch-cli-wrapper.md).

## Considered options

- **Upstream pi package, as is.** It has the fixed cost and the raw results. It can't be installed beside workspace tools of the same names, because Pi 1.3 refuses to load an extension that registers a name already taken.
- **`ketch mcp serve` with `codemode` exposure.** This removes the fixed cost, but every tool's description is the upstream text, the results stay raw, and the TUI cards are lost. `deferred` exposure only delays the cost, since `tool_search` loads every matching Ketch tool fully declared.
- **Slim tools that call the upstream tools through `ctx.executeTool`.** This still depends on the upstream schemas, and the upstream tools must stay registered.

## Consequences

We maintain the argument building, result formats and flag set ourselves. Two inherited pieces keep that manageable: the argument-hardening code and its tests, copied from upstream, and a test that fails when a Ketch release drops a flag we use. Anything the four tools leave out, including crawl, tags and backend selection, goes through the CLI. The workspace skill documents that path instead of the upstream skill, which we no longer install.
