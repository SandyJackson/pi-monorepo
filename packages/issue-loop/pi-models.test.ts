import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { workerExtensionArgs } from "./pi-models.ts";
import { defaultLoopSettings } from "./settings.ts";
import { installDefaultExtensions } from "./test-fixtures/extensions.ts";

it("loads codemode explicitly and disables MCP even without package extensions", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-extension-args-"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  installDefaultExtensions(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const settings = defaultLoopSettings();
  const packageArgs = await workerExtensionArgs(settings);
  expect(packageArgs).toEqual([
    "--no-extensions",
    "--no-mcp",
    "--extension",
    "builtin:codemode",
    "--extension",
    join(root, "npm", "node_modules", "pi-claude-bridge", "index.js"),
    "--extension",
    join(root, "git", "github.com", "1broseidon", "ketch", "index.js"),
  ]);
  settings.extensions = [];
  expect(await workerExtensionArgs(settings)).toEqual([
    "--no-extensions",
    "--no-mcp",
    "--extension",
    "builtin:codemode",
  ]);
});
