import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { workerExtensionArgs } from "./pi-models.ts";
import { defaultLoopSettings } from "./settings.ts";

/**
 * Offline smoke against the installed Pi executable. Opt-in because the result
 * depends on the local Pi install rather than fixtures. It sends no prompt, so
 * no model or paid provider is called.
 */
it.runIf(process.env.ISSUE_LOOP_PI_SMOKE === "1").each(["standalone", "loop"] as const)(
  "%s Pi exposes codemode, isolates MCP, answers framed commands, and shuts down",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "loop-pi-smoke-"));
    const sessionPath = join(root, "smoke.jsonl");
    const sessionName = "loop smoke · offline";
    const settings = defaultLoopSettings();
    const ketch = settings.extensions!.find(({ path }) => path.endsWith("/ketch"))!;
    settings.extensions = [ketch];
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [ketch.path] }));
    const mcpStarted = join(root, "mcp-started");
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          writer: {
            command: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(mcpStarted)}, 'started')`,
            ],
            exposure: "codemode",
          },
        },
      }),
    );
    const report = join(root, "tools.json");
    const probe = join(root, "probe.js");
    writeFileSync(
      probe,
      `
      import { writeFileSync } from "node:fs";
      export default (pi) => {
        pi.on("session_start", () => writeFileSync(${JSON.stringify(report)}, JSON.stringify({
          active: pi.getActiveTools(), all: pi.getAllTools().map(tool => tool.name),
          commands: pi.getCommands().map(command => command.name),
        })));
      };
    `,
    );
    const extensionArgs = mode === "loop" ? await workerExtensionArgs(settings) : ["--no-mcp"];
    const tools =
      mode === "loop" ? settings.review.tools : ["read", "grep", "find", "ls", "codemode"];
    // No prompts or provider calls. The probe observes the real CLI's tool registry.
    const child = spawn(
      process.env.ISSUE_LOOP_PI_BIN ?? "pi",
      [
        "--mode",
        "rpc",
        "--approve",
        ...extensionArgs,
        "--extension",
        probe,
        "--offline",
        "--no-context-files",
        "--name",
        sessionName,
        "--session",
        sessionPath,
        "--tools",
        tools.join(","),
        "--no-skills",
      ],
      {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    // Split on LF bytes only: U+2028 inside a JSON string is not a record boundary.
    const records: Record<string, unknown>[] = [];
    let buffered = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let end = buffered.indexOf(10); end !== -1; end = buffered.indexOf(10)) {
        records.push(JSON.parse(buffered.subarray(0, end).toString("utf8")));
        buffered = buffered.subarray(end + 1);
      }
    });
    const response = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const record = records.find((item) => item.type === "response" && item.id === id);
        if (record) return record as { success: boolean; data: Record<string, unknown> };
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Pi exited before responding to ${id}; stderr: ${stderr}`);
        await delay(50);
      }
      throw new Error(`No response to ${id}; stderr: ${stderr}`);
    };
    try {
      // A Unicode line separator in the echoed id proves LF-only framing.
      const stateId = "state\u2028framed";
      child.stdin.write(`${JSON.stringify({ id: stateId, type: "get_state" })}\n`);
      child.stdin.write(`${JSON.stringify({ id: "messages", type: "get_messages" })}\n`);
      const state = await response(stateId);
      expect(state.success).toBe(true);
      expect(state.data.sessionFile).toBe(sessionPath);
      expect(state.data.sessionName).toBe(sessionName);
      expect(state.data.isStreaming).toBe(false);
      const messages = await response("messages");
      expect(messages.success).toBe(true);
      expect(messages.data.messages).toEqual([]);
      const registry = JSON.parse(readFileSync(report, "utf8"));
      expect(registry.active).toEqual(expect.arrayContaining(tools));
      expect(registry.all.some((name: string) => name.startsWith("mcp__"))).toBe(false);
      expect(registry.commands).not.toContain("mcp");
      expect(existsSync(mcpStarted)).toBe(false);
      expect(registry.active.filter((name: string) => name.startsWith("ketch_"))).toEqual(
        mode === "loop"
          ? ["ketch_search", "ketch_code", "ketch_docs", "ketch_scrape", "ketch_crawl", "ketch_tag"]
          : [],
      );
      // Closing stdin requests an orderly shutdown.
      child.stdin.end();
      const [code] = await Promise.race([
        exited,
        delay(10_000).then(() => {
          throw new Error(`Pi did not exit after stdin closed; stderr: ${stderr}`);
        }),
      ]);
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
