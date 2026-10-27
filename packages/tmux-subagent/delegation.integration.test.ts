/**
 * End to end: a real Pi with only this extension delegates two tasks to two
 * agents, each child runs in a real tmux session on a disposable socket, and
 * the parent gets both answers back in order. A follow-up to one child after
 * its session is killed resumes the saved conversation.
 *
 * The model is a local mock OpenAI-compatible endpoint (no credentials): the
 * parent's model calls `subagent` when asked to DELEGATE, each child's model
 * echoes its instruction, and the parent's model echoes the tool result.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createParentRuntime } from "./parent.ts";
import { readAnswer } from "./pi-session.ts";
import { createStore } from "./store.ts";
import { createTmuxExec } from "./tmux.ts";

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

type ChatMessage = { role: string; content: unknown };

function messageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** The mock model's reply to one chat request, as an OpenAI streaming delta. */
function reply(messages: ChatMessage[]): Record<string, unknown> {
  const last = messages.at(-1);
  if (last?.role === "tool") return { content: `PARENT SAW:\n${messageText(last)}` };
  const text = messageText(last);
  if (text.includes("DELEGATE")) {
    return {
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: {
            name: "subagent",
            arguments: JSON.stringify({
              tasks: [
                { agent: "alpha", instruction: "say ALPHA" },
                { agent: "beta", instruction: "say BETA" },
              ],
              label: "e2e",
              timeout: 2,
            }),
          },
        },
      ],
    };
  }
  return { content: `ECHO: ${text}` };
}

function startMockModel(): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let messages: ChatMessage[];
      try {
        messages = (JSON.parse(body) as { messages: ChatMessage[] }).messages;
      } catch {
        response.writeHead(404).end();
        return;
      }
      const delta = reply(messages);
      const chunk = (choice: Record<string, unknown>) =>
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ delta: { role: "assistant", ...delta }, finish_reason: null }));
      response.write(chunk({ delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }));
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let server: Server;
let root: string;
const socket = `pi-sa-e2e-${randomBytes(4).toString("hex")}`;

beforeAll(async () => {
  if (!hasTmux) return;
  server = await startMockModel();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-e2e-")));
});

afterAll(async () => {
  if (!hasTmux) return;
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // No server left to kill.
  }
  // tmux 3.8 can leave the socket file behind after its server exits.
  const uid = process.getuid?.();
  if (uid !== undefined) {
    fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${uid}`, socket), { force: true });
  }
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}, 20_000);

it.skipIf(!hasTmux)(
  "delegates two tasks through tmux children and returns both answers in order",
  async () => {
    const agentDir = path.join(root, "agent");
    const projectDir = path.join(root, "project");
    fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
    fs.mkdirSync(projectDir);
    const port = (server.address() as AddressInfo).port;
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "mock",
            models: [{ id: "echo" }],
          },
        },
      }),
    );
    // Children load extensions from settings, so the extension is configured there.
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "mock",
        defaultModel: "echo",
        extensions: [
          path.join(import.meta.dirname, "index.ts"),
          "-builtin:mcp",
          "-builtin:llama.cpp",
          "-builtin:codemode",
          "-builtin:tool-search",
        ],
      }),
    );
    for (const name of ["alpha", "beta"]) {
      fs.writeFileSync(
        path.join(agentDir, "agents", `${name}.md`),
        `---\nname: ${name}\ndescription: ${name} agent\ntools: read\n---\nYou are ${name}.\n`,
      );
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENT_TMUX_SOCKET: socket,
      PI_OFFLINE: "1",
    };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.PI_SUBAGENT_NONCE;
    const cli = path.join(getPackageDir(), "dist", "bundle", "cli.js");
    const stdout = await new Promise<string>((resolve, reject) => {
      const parent = execFile(
        process.execPath,
        [cli, "--print", "--session-dir", path.join(root, "parent-sessions"), "DELEGATE"],
        { cwd: projectDir, env, timeout: 90_000 },
        (error, out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out)),
      );
      // Print mode reads piped stdin to EOF before running the prompt.
      parent.stdin?.end();
    });

    expect(stdout).toContain("Delegation: 2/2 tasks completed");
    const alpha = stdout.indexOf("### Task 1 — alpha — completed");
    const beta = stdout.indexOf("### Task 2 — beta — completed");
    expect(alpha).toBeGreaterThan(-1);
    expect(beta).toBeGreaterThan(alpha);
    expect(stdout.slice(alpha, beta)).toContain("ECHO: say ALPHA");
    expect(stdout.slice(beta)).toContain("ECHO: say BETA");

    // Each child's own records, read through the validating store.
    const store = createStore(path.join(agentDir, "subagents"));
    const childIds = fs.readdirSync(path.join(store.root, "children")).sort();
    expect(childIds).toEqual([expect.stringMatching(/^alpha-/), expect.stringMatching(/^beta-/)]);
    for (const [index, childId] of childIds.entries()) {
      const child = store.readChild(childId);
      expect(child).toMatchObject({
        cwd: projectDir,
        worktree: projectDir,
        label: "e2e",
        taskNumber: index + 1,
        depth: 1,
        agent: { tools: ["read"] },
      });
      const request = { childId, requestId: "r1" };
      const result = store.readResult(request);
      expect(result).toMatchObject({ phase: "settled", result: { status: "completed" } });
      if (result?.phase !== "settled" || result.result.status !== "completed") continue;
      const answer = result.result.answer;
      expect(answer?.path.startsWith(path.join(store.childDir(childId), "session"))).toBe(true);
      expect(answer && readAnswer(answer)).toBe(`ECHO: say ${index === 0 ? "ALPHA" : "BETA"}`);
      const status = store.readStatus(childId);
      expect(status).toMatchObject({ nonce: result.nonce, state: "idle" });
      // The child stays live for later inspection.
      execFileSync("tmux", ["-L", socket, "has-session", "-t", `=sa-${childId}`]);
    }

    // A follow-up to a stopped child resumes its saved conversation and answers.
    const [alphaId] = childIds;
    execFileSync("tmux", ["-L", socket, "kill-session", "-t", `=sa-${alphaId}`]);
    const runtime = createParentRuntime({
      parentSessionId: store.readChild(alphaId).parent.sessionId,
      parentCwd: projectDir,
      isProjectTrusted: () => true,
      store,
      tmux: createTmuxExec(socket),
    });
    const launcherEnv = { ...process.env };
    Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" });
    let asked: Awaited<ReturnType<typeof runtime.ask>>;
    try {
      asked = await runtime.ask(alphaId, "say AGAIN", { timeoutMs: 60_000 });
    } finally {
      process.env = launcherEnv;
    }
    const followUp = { childId: alphaId, requestId: "r2" };
    if (asked.status === "rejected") throw new Error(`ask rejected: ${asked.error}`);
    expect(asked).toMatchObject({
      status: "submitted",
      request: followUp,
      retrieval: { status: "settled", result: { status: "completed" } },
    });
    const followUpResult = store.readResult(followUp);
    if (followUpResult?.phase !== "settled" || followUpResult.result.status !== "completed") {
      throw new Error("follow-up did not complete");
    }
    const followUpAnswer = followUpResult.result.answer;
    expect(followUpAnswer && readAnswer(followUpAnswer)).toBe("ECHO: say AGAIN");
    // The same conversation: the first answer is still in the one session file.
    expect(fs.readdirSync(path.join(store.childDir(alphaId), "session"))).toHaveLength(1);
    expect(fs.readFileSync(followUpAnswer?.path ?? "", "utf8")).toContain("ECHO: say ALPHA");

    const retrieved = await runtime.retrieveResult(followUp, { timeoutMs: 1_000 });
    expect(retrieved).toEqual({
      status: "settled",
      request: followUp,
      result: followUpResult.result,
    });
  },
  180_000,
);
