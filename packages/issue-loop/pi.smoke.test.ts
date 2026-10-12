import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { assertSupportedPi } from "./pi-version.ts";

/**
 * Offline smoke against the installed Pi executable. Opt-in because the result
 * depends on the local Pi install rather than fixtures. It sends no prompt, so
 * no model or paid provider is called.
 */
it.runIf(process.env.ISSUE_LOOP_PI_SMOKE === "1")(
  "starts installed Pi in worker RPC mode, answers framed commands, and shuts down",
  async () => {
    await assertSupportedPi();
    const root = mkdtempSync(join(tmpdir(), "loop-pi-smoke-"));
    const sessionPath = join(root, "smoke.jsonl");
    const sessionName = "loop smoke · offline";
    // The worker launch flags, minus model/thinking/skills which need a prompt to matter.
    const child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--approve",
        "--no-extensions",
        "--name",
        sessionName,
        "--session",
        sessionPath,
        "--tools",
        "read",
        "--no-skills",
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
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
      child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
