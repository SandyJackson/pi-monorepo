import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CustomMessageEntry,
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  type Model,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWorktrunk } from "./index.ts";
import {
  findUndeliveredRelocation,
  prepareTargetSession,
  RELOCATION_CUSTOM_TYPE,
  type RelocationRecord,
} from "./worktrunk.ts";

let tempDir: string;
let sessionDir: string;
let agentDir: string;
let target: string;
let sessions: AgentSession[];

beforeEach(() => {
  sessions = [];
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktrunk-relocation-")));
  sessionDir = path.join(tempDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  agentDir = path.join(tempDir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  // A tiny keep-recent budget makes a short conversation compactable without
  // seeding tens of thousands of tokens.
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 10 } }),
  );
  target = path.join(tempDir, "target");
  fs.mkdirSync(target, { recursive: true });
});

afterEach(() => {
  for (const session of sessions) session.dispose();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const CANNED_SUMMARY = "canned summary of the relocated conversation";

/** Record the stream calls and answer with a fixed assistant text. */
function fakeStream(calls: Context[]) {
  return (
    model: Model,
    context: Context,
    _options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    calls.push(context);
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  };
}

async function createTestRuntime(
  calls: Context[],
): Promise<{ modelRuntime: ModelRuntime; model: Model }> {
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  modelRuntime.registerProvider("worktrunk-test", {
    name: "Worktrunk Test",
    apiKey: "test-key",
    api: "worktrunk-test-api",
    baseUrl: "http://127.0.0.1:1/unused",
    models: [
      {
        id: "test-model",
        name: "Test Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4_096,
      },
    ],
    streamSimple: fakeStream(calls),
  });
  const model = modelRuntime.getModel("worktrunk-test", "test-model");
  if (!model) throw new Error("the test model was not registered");
  return { modelRuntime, model };
}

function extensionFactories(): InlineExtension[] {
  return [
    {
      name: "worktrunk",
      factory: (pi) =>
        registerWorktrunk(pi, async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ schema: 2, items: [] }),
          stderr: "",
        })),
    },
    {
      name: "canned-compaction",
      factory: (pi) =>
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: CANNED_SUMMARY,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        })),
    },
  ];
}

/** Create a real AgentSession over `sessionFile` and fire the session_start event. */
async function createSession(
  sessionFile: string,
  modelRuntime: ModelRuntime,
  model: Model,
): Promise<AgentSession> {
  const settingsManager = SettingsManager.create(target, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: target,
    agentDir,
    settingsManager,
    extensionFactories: extensionFactories(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: target,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    modelRuntime,
    model,
    sessionManager: SessionManager.open(sessionFile),
    sessionStartEvent: { type: "session_start", reason: "resume" },
  });
  await session.bindExtensions({});
  sessions.push(session);
  return session;
}

/** Carry a source conversation into a persisted target session. */
function relocatedSource(inputTokens = 0): {
  prepared: string;
  record: RelocationRecord;
  recordId: string;
} {
  const source = path.join(tempDir, "source");
  fs.mkdirSync(source, { recursive: true });
  const manager = SessionManager.create(source, sessionDir);
  manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const response: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "original checkout response" }],
    api: "worktrunk-test-api",
    provider: "worktrunk-test",
    model: "test-model",
    usage: {
      input: inputTokens,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
  manager.appendMessage(response);
  manager.appendMessage({ role: "user", content: "second", timestamp: 3 });
  manager.appendMessage({ ...response, timestamp: 4 });
  const record: RelocationRecord = {
    branch: "main",
    sourcePath: source,
    targetPath: target,
    note: `Worktree relocation: this session moved from ${source} to ${target} (branch main).`,
  };
  const prepared = prepareTargetSession(manager, target, record, sessionDir);
  const leaf = SessionManager.open(prepared).getLeafEntry();
  if (leaf?.type !== "custom") throw new Error("prepared session has no relocation record");
  return { prepared, record, recordId: leaf.id };
}

function relocationDeliveries(sessionFile: string): CustomMessageEntry[] {
  const branch = SessionManager.open(sessionFile).getBranch();
  return branch.filter(
    (entry): entry is CustomMessageEntry =>
      entry.type === "custom_message" && entry.customType === RELOCATION_CUSTOM_TYPE,
  );
}

describe("worktrunk relocation lifecycle (real runtime)", () => {
  it("recovers after close before a prompt, survives reload, and delivers once across resumes", async () => {
    const { prepared, record, recordId } = relocatedSource();
    const calls: Context[] = [];
    const { modelRuntime, model } = await createTestRuntime(calls);

    const abandoned = await createSession(prepared, modelRuntime, model);
    expect(relocationDeliveries(prepared)).toHaveLength(0);
    expect(calls).toHaveLength(0);
    abandoned.dispose();

    const session = await createSession(prepared, modelRuntime, model);
    await session.reload();
    await session.prompt("continue");

    const deliveries = relocationDeliveries(prepared);
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect(delivery.display).toBe(false);
    expect(delivery.content).toBe(record.note);
    expect(delivery.details).toEqual({ relocationId: recordId });
    expect(findUndeliveredRelocation(SessionManager.open(prepared).getBranch(), target)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.messages)).toContain(record.note);
    session.dispose();

    const reopened = await createSession(prepared, modelRuntime, model);
    await reopened.prompt("after reopen");
    expect(relocationDeliveries(prepared)).toHaveLength(1);
  });

  it("delivers after pre-prompt compaction and retains deduplication on resume", async () => {
    const { prepared, record, recordId } = relocatedSource(99_001);
    const calls: Context[] = [];
    const { modelRuntime, model } = await createTestRuntime(calls);

    const session = await createSession(prepared, modelRuntime, model);
    await session.prompt("continue");

    const afterCompaction = SessionManager.open(prepared);
    const branch = afterCompaction.getBranch();
    const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
    const deliveryIndex = branch.findIndex((entry) => entry.type === "custom_message");
    expect(compactionIndex).toBeGreaterThanOrEqual(0);
    expect(deliveryIndex).toBeGreaterThan(compactionIndex);
    expect(JSON.stringify(calls[0]?.messages)).toContain(record.note);
    const compaction = branch[compactionIndex];
    if (compaction?.type !== "compaction") throw new Error("no compaction entry was appended");
    expect(compaction.summary).toBe(CANNED_SUMMARY);
    expect(compaction.fromHook).toBe(true);
    // Compaction keeps every entry on the branch, so the record and its
    // delivery marker are still visible to the session_start handler.
    expect(findUndeliveredRelocation(afterCompaction.getBranch(), target)).toBeNull();

    session.dispose();
    const reopened = await createSession(prepared, modelRuntime, model);
    await reopened.prompt("after compaction");
    expect(relocationDeliveries(prepared)).toHaveLength(1);
    expect(relocationDeliveries(prepared)[0]?.details).toEqual({ relocationId: recordId });
  });
});
