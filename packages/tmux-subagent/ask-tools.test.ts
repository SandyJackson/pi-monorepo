import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createFollowUpTools } from "./ask-tools.ts";
import type { AskOutcome, ParentRuntime, RetrievalOutcome } from "./parent.ts";

const request = { childId: "scout-7k2q", requestId: "r2" };
const header = "Child scout-7k2q, request r2\n\n";

function harness(defaultTimeoutMinutes?: number) {
  const ask = vi.fn<ParentRuntime["ask"]>();
  const retrieveResult = vi.fn<ParentRuntime["retrieveResult"]>();
  const [askTool, retrieveTool] = createFollowUpTools({
    ask,
    retrieveResult,
    defaultTimeoutMinutes: () => defaultTimeoutMinutes,
  });
  return { ask, retrieveResult, askTool, retrieveTool };
}

async function text(
  tool: ReturnType<typeof harness>["askTool"] | ReturnType<typeof harness>["retrieveTool"],
  params: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute("call", params as never, undefined, undefined, {} as never);
  const [content] = result.content;
  return content.type === "text" ? content.text : "";
}

const retrievalCases: Array<{ name: string; outcome: RetrievalOutcome; text: string }> = [
  {
    name: "completed with operator input",
    outcome: {
      status: "settled",
      request,
      result: { status: "completed", answer: null, humanIntervened: true },
    },
    text: `${header}The operator also interacted with this child during the request; the answer may address their input.\n\nThe request completed without a final answer.`,
  },
  {
    name: "failed",
    outcome: {
      status: "settled",
      request,
      result: { status: "failed", reason: "error", error: "boom", humanIntervened: false },
    },
    text: `${header}Request failed (error): boom`,
  },
  {
    name: "interrupted",
    outcome: {
      status: "settled",
      request,
      result: { status: "failed", reason: "interrupted", error: "stopped", humanIntervened: false },
    },
    text: `${header}Request failed (interrupted): stopped\nNo result was recorded. The child may have made changes. The request will not be retried automatically.`,
  },
  {
    name: "pending",
    outcome: { status: "pending", request, state: "blocked", stopped: "timed_out" },
    text: `${header}Still blocked. Use subagent_retrieve with childId scout-7k2q and requestId r2 to keep waiting.`,
  },
  {
    name: "lost after starting",
    outcome: { status: "lost", request, started: true },
    text: `${header}The child stopped while working on this request and recorded no result. It may have made changes. It will be marked interrupted, not re-run, when the child next starts.`,
  },
  {
    name: "lost before starting",
    outcome: { status: "lost", request, started: false },
    text: `${header}The child stopped before starting this request. The request is still queued and runs when the child next starts. subagent_ask starts the child but also submits its new instruction.`,
  },
];

describe("subagent_retrieve", () => {
  it.each(retrievalCases)(
    "presents $name with the specified text",
    async ({ outcome, text: expected }) => {
      const { retrieveResult, retrieveTool } = harness();
      retrieveResult.mockResolvedValue(outcome);

      expect(await text(retrieveTool, { childId: "scout-7k2q", requestId: "r2" })).toBe(expected);
    },
  );

  it("carries the outcome, never answer text, in details", async () => {
    const { retrieveResult, retrieveTool } = harness();
    const outcome: RetrievalOutcome = {
      status: "settled",
      request,
      result: {
        status: "completed",
        answer: { path: "/missing.jsonl", entryId: "e1" },
        humanIntervened: false,
      },
    };
    retrieveResult.mockResolvedValue(outcome);

    const result = await retrieveTool.execute(
      "call",
      { childId: "scout-7k2q", requestId: "r2" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toEqual(outcome);
  });

  it.each([
    { timeout: 3, fallback: 7, expectedMs: 180_000 },
    { timeout: undefined, fallback: 7, expectedMs: 420_000 },
    { timeout: undefined, fallback: undefined, expectedMs: 3_600_000 },
  ])(
    "waits $expectedMs ms for timeout $timeout and agent default $fallback",
    async ({ timeout, fallback, expectedMs }) => {
      const { retrieveResult, retrieveTool } = harness(fallback);
      retrieveResult.mockResolvedValue({ status: "lost", request, started: false });

      await text(retrieveTool, { childId: "scout-7k2q", requestId: "r2", timeout });

      expect(retrieveResult.mock.calls[0][0]).toEqual(request);
      expect(retrieveResult.mock.calls[0][1].timeoutMs).toBe(expectedMs);
    },
  );

  it("has a strict schema", () => {
    const { retrieveTool } = harness();
    expect(Value.Check(retrieveTool.parameters, { childId: "a", requestId: "r1", extra: 1 })).toBe(
      false,
    );
    expect(
      Value.Check(retrieveTool.parameters, { childId: "a", requestId: "r1", timeout: 0 }),
    ).toBe(false);
  });
});

describe("subagent_ask", () => {
  it("presents a submitted request through its retrieval outcome", async () => {
    const { ask, askTool } = harness(5);
    ask.mockResolvedValue({
      status: "submitted",
      request,
      retrieval: { status: "pending", request, state: "queued", stopped: "aborted" },
    });

    expect(await text(askTool, { childId: "scout-7k2q", instruction: "  More  " })).toBe(
      `${header}Still queued. Use subagent_retrieve with childId scout-7k2q and requestId r2 to keep waiting.`,
    );
    expect(ask.mock.calls[0][0]).toBe("scout-7k2q");
    expect(ask.mock.calls[0][1]).toBe("More");
    expect(ask.mock.calls[0][2].timeoutMs).toBe(300_000);
  });

  it.each<{ outcome: AskOutcome; text: string }>([
    {
      outcome: {
        status: "rejected",
        childId: "scout-7k2q",
        reason: "busy",
        error:
          "Child scout-7k2q already has a request running and one queued. Nothing was submitted.",
      },
      text: "Child scout-7k2q already has a request running and one queued. Nothing was submitted.",
    },
    {
      outcome: {
        status: "rejected",
        childId: "scout-7k2q",
        reason: "invalid_target",
        error: "Child scout-7k2q belongs to another parent session.",
      },
      text: "Child scout-7k2q belongs to another parent session.",
    },
  ])(
    "presents a $outcome.reason rejection as its error text",
    async ({ outcome, text: expected }) => {
      const { ask, askTool } = harness();
      ask.mockResolvedValue(outcome);

      expect(await text(askTool, { childId: "scout-7k2q", instruction: "More" })).toBe(expected);
    },
  );

  it("refuses an empty instruction without asking", async () => {
    const { ask, askTool } = harness();

    await expect(text(askTool, { childId: "scout-7k2q", instruction: "  " })).rejects.toThrow(
      /must not be empty/,
    );
    expect(ask).not.toHaveBeenCalled();
  });
});
