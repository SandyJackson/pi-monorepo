// One end-to-end check through the extension entrypoint and the real ketch
// binary, against a page served from this process, so nothing leaves the
// machine. Skipped when ketch isn't on PATH.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ketch from "./index.ts";
import type { Exec } from "./runner.ts";

function onPath(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// An isolated home: no operator config or page cache is read or written.
const home = mkdtempSync(join(tmpdir(), "pi-ketch-e2e-"));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KETCH_"))),
  HOME: home,
  XDG_CACHE_HOME: join(home, "cache"),
  XDG_CONFIG_HOME: join(home, "config"),
  KETCH_CONFIG: join(home, "config.json"),
  KETCH_NO_UPDATE_NOTIFIER: "1",
};

// The same contract as pi.exec: resolve with the exit code, never reject on failure.
const exec: Exec = (command, args, { signal, timeout }) =>
  new Promise((resolve) => {
    execFile(command, args, { env, signal, timeout }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({
        stdout,
        stderr,
        code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
        killed: Boolean(e?.killed),
      });
    });
  });

function loadTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    exec,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  ketch(pi);
  return tools;
}

describe.skipIf(!onPath("ketch"))("ketch extension end to end", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><head><title>Fixture</title></head><body><main>" +
          `<h1>Hello</h1><p>${"lorem ipsum ".repeat(400)}</p></main></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  it("scrapes a local page through the registered tool", async () => {
    const scrape = loadTools().get("ketch_scrape")!;
    const r = await scrape.execute(
      "call",
      { url: `${base}/page`, max_chars: 200, no_cache: true },
      undefined,
      undefined,
      {} as never,
    );

    expect(r.isError).toBeUndefined();
    expect((r.content[0] as { text: string }).text).toMatch(
      new RegExp(`^## \\[Fixture\\]\\(${base}/page\\)\\n\\n# Hello`),
    );
    expect(r.structuredContent).toMatchObject({
      pages: [
        { url: `${base}/page`, title: "Fixture", markdown: expect.stringContaining("[truncated]") },
      ],
    });
  });
});
