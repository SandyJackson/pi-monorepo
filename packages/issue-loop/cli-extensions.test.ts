import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  readState,
  readWorkers,
  runDirFrom,
  writeLoopSettings,
} from "./cli-fixture.ts";

function installBridge(root: string): void {
  mkdirSync(join(root, "skills", "unselected"), { recursive: true });
  writeFileSync(join(root, "index.js"), "export default () => {};\n");
  writeFileSync(
    join(root, "skills", "unselected", "SKILL.md"),
    "---\nname: unselected\ndescription: Not a loop skill\n---\n\nUnselected skill.",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      version: "1.2.3",
      pi: { extensions: ["./index.js"], skills: ["./skills"] },
    }),
  );
}

cliTest(
  "starts with the installed default bridge and Ketch extensions without a settings file",
  async () => {
    const f = fixture();
    const bridge = join(f.env.PI_CODING_AGENT_DIR, "npm", "node_modules", "pi-claude-bridge");
    const ketch = join(f.env.PI_CODING_AGENT_DIR, "git", "github.com", "1broseidon", "ketch");
    f.env.FIXTURE_MODEL_EXTENSION = join(bridge, "index.js");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    expect(readState(runDirFrom(result)).settings.extensions).toEqual([
      { path: bridge, version: "1.2.3" },
      { path: ketch, version: "1.2.3" },
    ]);
    for (const worker of readWorkers(f.root)) {
      expect(worker.args).toContain("--no-extensions");
      expect(worker.args).toContain("--no-mcp");
      expect(worker.args).toContain("builtin:codemode");
      expect(worker.args).toContain(join(bridge, "index.js"));
      expect(worker.args).toContain(join(ketch, "index.js"));
      expect(worker.args).not.toContain(bridge);
      expect(worker.args).not.toContain(ketch);
    }
  },
  30_000,
);

cliTest(
  "reports a missing default package before creating a run",
  async () => {
    const f = fixture();
    rmSync(join(f.env.PI_CODING_AGENT_DIR, "git", "github.com", "1broseidon", "ketch"), {
      recursive: true,
    });
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot load loop extension");
    expect(result.stderr).toContain("ketch");
    expect(existsSync(join(f.root, ".pi-issue-loops"))).toBe(false);
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
  },
  30_000,
);

cliTest(
  "rejects an unavailable bridge model when extensions are explicitly disabled",
  async () => {
    const f = fixture();
    f.env.FIXTURE_MODEL_EXTENSION = join(f.root, "bridge");
    const settingsPath = join(f.root, "no-extensions.json");
    writeFileSync(settingsPath, '{"extensions":[]}');
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("implement");
    expect(result.stderr).toContain('Model "claude-bridge/claude-opus-5-5" not found');
    expect(result.stderr).toContain("extensions");
    expect(existsSync(join(f.root, ".pi-issue-loops"))).toBe(false);
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
  },
  30_000,
);

cliTest.each([
  ["openai-codex/gpt-6.1-sol", "review"],
  ["default", "describe"],
])(
  "preflights the %s model without prompting",
  async (model, role) => {
    const f = fixture();
    f.env.FIXTURE_MISSING_MODEL = model;
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(role);
    expect(result.stderr).toContain(`Model "${model}" not found`);
    expect(existsSync(join(f.root, ".pi-issue-loops"))).toBe(false);
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
  },
  30_000,
);

cliTest(
  "loads only allowlisted extensions for preflight, workers and resume",
  async () => {
    const f = fixture("fail");
    const settingsPath = writeLoopSettings(f.root);
    const bridge = join(f.root, "bridge");
    installBridge(bridge);
    const entrypoint = join(bridge, "index.js");
    const config = JSON.parse(readFileSync(settingsPath, "utf8"));
    writeFileSync(settingsPath, JSON.stringify({ ...config, extensions: ["../bridge"] }));
    f.env.FIXTURE_MODEL_EXTENSION = entrypoint;
    const first = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first);
    expect(readState(runDir).settings.extensions).toEqual([{ path: bridge, version: "1.2.3" }]);
    const workerCount = readWorkers(f.root).length;
    rmSync(bridge, { recursive: true });
    const missing = await f.run("resume", runDir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(bridge);
    expect(readWorkers(f.root)).toHaveLength(workerCount);

    installBridge(bridge);
    rmSync(join(f.root, "loop-settings"), { recursive: true });
    f.env.FIXTURE_MISSING_MODEL = "test-provider/review-model";
    const unavailable = await f.run("resume", runDir);
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain('Model "test-provider/review-model" not found');
    expect(readWorkers(f.root)).toHaveLength(workerCount);
    f.env.FIXTURE_MISSING_MODEL = "";
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readState(runDir).settings.extensions).toEqual([{ path: bridge, version: "1.2.3" }]);
    for (const worker of readWorkers(f.root)) {
      expect(worker.args).toContain("--no-extensions");
      expect(worker.args).toContain("--no-mcp");
      expect(worker.args).toContain("builtin:codemode");
      const index = worker.args.indexOf(entrypoint);
      expect(worker.args[index - 1]).toBe("--extension");
      expect(worker.args).not.toContain(bridge);
      expect(worker.args).not.toContain(join(bridge, "skills"));
      expect(worker.args.filter((arg) => arg === "--extension")).toHaveLength(2);
    }
    const preflights = readFileSync(join(f.root, "preflights.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(preflights.length).toBeGreaterThanOrEqual(6);
    for (const probe of preflights) {
      expect(probe.args).toContain("--no-extensions");
      expect(probe.args).toContain("--no-mcp");
      expect(probe.args).toContain("builtin:codemode");
      expect(probe.args).toContain("--no-session");
      expect(probe.args).toContain("--offline");
      expect(probe.args).not.toContain("--print");
      const index = probe.args.indexOf(entrypoint);
      expect(probe.args[index - 1]).toBe("--extension");
    }
  },
  60_000,
);
