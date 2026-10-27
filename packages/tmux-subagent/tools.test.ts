import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { type AgentConfig, discoverProjectAgents } from "./agents.ts";
import type {
  AskOutcome,
  DelegatedTaskOutcome,
  ExecuteDelegation,
  ParentRuntime,
  RetrievalOutcome,
} from "./parent.ts";
import { createFollowUpTools, createSubagentTool } from "./tools.ts";

const alphaAgent: AgentConfig = {
  name: "alpha",
  description: "Alpha agent",
  systemPromptBody: "",
  source: "user",
  sourceDir: "/agents",
  filePath: "/agents/alpha.md",
};

function createTool(agents: AgentConfig[] = [alphaAgent]) {
  const executeDelegation = vi.fn<ExecuteDelegation>();
  const tool = createSubagentTool({
    agents,
    parentCwd: "/parent",
    includeProjectAgents: false,
    executeDelegation,
  });
  return { tool, executeDelegation };
}

async function executeTool(
  tool: ReturnType<typeof createTool>["tool"],
  params: Parameters<typeof tool.execute>[1],
) {
  return tool.execute("tool-call", params, undefined, undefined, {} as never);
}

async function withSessionFile(
  entries: unknown[],
  test: (sessionPath: string) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tool-session-"));
  const sessionPath = path.join(directory, "session.jsonl");
  fs.writeFileSync(sessionPath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  try {
    await test(sessionPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("agent frontmatter timeout", () => {
  it.each(["0", "-1", "1.5", "nope", "true", "null", '"90"', "[]", "{}"])(
    "rejects invalid timeout %s with the agent file and requirement",
    async (timeout) => {
      await withSessionFile([], async (sessionPath) => {
        const root = path.dirname(sessionPath);
        const agentsDir = path.join(root, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        const agentPath = path.join(agentsDir, "alpha.md");
        fs.writeFileSync(
          agentPath,
          `---\nname: alpha\ndescription: Alpha\ntimeout: ${timeout}\n---\n`,
        );
        expect(() => discoverProjectAgents(root)).toThrow(
          `${agentPath}: frontmatter \`timeout\` must be a positive integer number of minutes`,
        );
      });
    },
  );
});

describe("subagent timeout precedence", () => {
  it.each([
    { callTimeout: undefined, expectedMinutes: [90, 1, 60] },
    { callTimeout: 2, expectedMinutes: [2, 2, 2] },
  ])(
    "uses call timeout $callTimeout before each agent default",
    async ({ callTimeout, expectedMinutes }) => {
      await withSessionFile([], async (sessionPath) => {
        const root = path.dirname(sessionPath);
        const agentsDir = path.join(root, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, "reviewer.md"),
          "---\nname: reviewer\ndescription: Reviewer\ntimeout: 90\n---\n",
        );
        fs.writeFileSync(
          path.join(agentsDir, "quick.md"),
          "---\nname: quick\ndescription: Quick\ntimeout: 1\n---\n",
        );
        const { tool, executeDelegation } = createTool([
          ...discoverProjectAgents(root),
          alphaAgent,
        ]);
        executeDelegation.mockImplementation(async (tasks) =>
          tasks.map((task) => ({
            task,
            outcome: { status: "timed_out", request },
          })),
        );

        const result = await executeTool(tool, {
          tasks: ["reviewer", "quick", "alpha"].map((agent) => ({ agent, instruction: "Review" })),
          timeout: callTimeout,
        });

        expect(executeDelegation.mock.calls[0][0].map((task) => task.timeoutMs)).toEqual(
          callTimeout === undefined ? [5_400_000, 60_000, 3_600_000] : [120_000, 120_000, 120_000],
        );
        const text = result.content[0].type === "text" ? result.content[0].text : "";
        expectedMinutes.forEach((minutes, index) => {
          const agent = ["reviewer", "quick", "alpha"][index];
          expect(text).toContain(
            `### Task ${index + 1} — ${agent} — timed out\n\nChild alpha-7k2q, request r1\n\nThe wait timed out after ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
          );
        });
      });
    },
  );
});

describe("subagent request schema", () => {
  it("accepts only the strict current request and task shape", () => {
    const schema = createTool().tool.parameters;

    expect(Value.Check(schema, {})).toBe(true);
    expect(
      Value.Check(schema, {
        tasks: [{ agent: "alpha", instruction: "Review", cwd: "relative/path" }],
        timeout: 1,
      }),
    ).toBe(true);
    expect(Value.Check(schema, { obsolete: true })).toBe(false);
    expect(
      Value.Check(schema, {
        tasks: [{ agent: "alpha", instruction: "Review" }],
        label: "review-issue-13",
      }),
    ).toBe(true);
    expect(Value.Check(schema, { label: 42 })).toBe(false);
    expect(
      Value.Check(schema, {
        tasks: [{ agent: "alpha", instruction: "Review", extra: true }],
      }),
    ).toBe(false);
    expect(
      Value.Check(schema, { tasks: [{ agent: "alpha", instruction: "Review" }], timeout: 1.5 }),
    ).toBe(false);
    expect(
      Value.Check(schema, {
        tasks: Array.from({ length: 9 }, () => ({ agent: "alpha", instruction: "Review" })),
      }),
    ).toBe(false);
  });
});

const request = { childId: "alpha-7k2q", requestId: "r1" };
const header = "Child alpha-7k2q, request r1\n\n";
const stillWorking =
  "The child is still working on the request; nothing was stopped. Use subagent_retrieve with childId alpha-7k2q and requestId r1 to keep waiting.";

const statusCases: Array<{
  name: string;
  outcome: DelegatedTaskOutcome;
  timeout?: number;
  headingStatus: string;
  text: string;
}> = [
  {
    name: "timeout",
    outcome: { status: "timed_out", request },
    timeout: 3,
    headingStatus: "timed out",
    text: `${header}The wait timed out after 3 minutes. ${stillWorking}`,
  },
  {
    name: "abort before launch",
    outcome: { status: "aborted", stage: "before_launch" },
    headingStatus: "aborted",
    text: "The delegated task was aborted before launch. No child was created.",
  },
  {
    name: "abort while observing",
    outcome: { status: "aborted", stage: "observing", request },
    headingStatus: "aborted",
    text: `${header}The wait was aborted. ${stillWorking}`,
  },
  {
    name: "child exit",
    outcome: { status: "session_closed", request },
    headingStatus: "session closed",
    text: `${header}The child stopped before recording a result for this request. It may have made changes.`,
  },
  {
    name: "failure",
    outcome: {
      status: "failed",
      request,
      reason: "error",
      error: "The child's run ended with an error.",
    },
    headingStatus: "failed",
    text: `${header}Request failed (error): The child's run ended with an error.`,
  },
  {
    name: "interruption",
    outcome: { status: "failed", request, reason: "interrupted", error: "Escape" },
    headingStatus: "failed",
    text: `${header}Request failed (interrupted): Escape\nNo result was recorded. The child may have made changes. The request will not be retried automatically.`,
  },
  {
    name: "confirmed launch failure",
    outcome: { status: "launch_failed", childId: "alpha-7k2q", error: "launch denied" },
    headingStatus: "launch failed",
    text: "Child alpha-7k2q could not be launched: launch denied",
  },
  {
    name: "launch failure before a child exists",
    outcome: { status: "launch_failed", error: "disk full" },
    headingStatus: "launch failed",
    text: "The subagent could not be launched: disk full",
  },
  {
    name: "indeterminate launch",
    outcome: { status: "launch_indeterminate", request, error: "No readiness within 30 s." },
    headingStatus: "launch indeterminate",
    text: `${header}The child did not confirm it started: No readiness within 30 s. The request is on disk and may still run.`,
  },
  {
    name: "observation failure",
    outcome: { status: "observation_failed", request, error: "invalid result.json" },
    headingStatus: "observation failed",
    text: `${header}Observation failed: invalid result.json. The child may still be running the request.`,
  },
];

describe("subagent result presentation", () => {
  it.each(statusCases)(
    "presents $name with precise text and normalized details",
    async ({ outcome, timeout, text }) => {
      const { tool, executeDelegation } = createTool();
      executeDelegation.mockImplementation(async (tasks) => [{ task: tasks[0], outcome }]);

      const result = await executeTool(tool, {
        tasks: [{ agent: "alpha", instruction: "Review" }],
        timeout,
      });

      expect(result).toEqual({
        content: [{ type: "text", text }],
        details: {
          tasks: [{ taskNumber: 1, agent: "alpha", ...outcome }],
        },
      });
    },
  );
  it("says so when a completed single task has no answer", async () => {
    const { tool, executeDelegation } = createTool();
    executeDelegation.mockImplementation(async (tasks) => [
      {
        task: tasks[0],
        outcome: { status: "completed", request, answer: null, humanIntervened: false },
      },
    ]);

    const result = await executeTool(tool, {
      tasks: [{ agent: "alpha", instruction: "Review" }],
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `${header}The request completed without a final answer.`,
        },
      ],
      details: {
        tasks: [
          {
            taskNumber: 1,
            agent: "alpha",
            status: "completed",
            request,
            answer: null,
            humanIntervened: false,
          },
        ],
      },
    });
  });

  it("numbers every precise status in a multiple-task result", async () => {
    const { tool, executeDelegation } = createTool();
    executeDelegation.mockImplementation(async (tasks) =>
      tasks.map((task, index) => ({
        task,
        outcome: statusCases[index].outcome,
      })),
    );

    const result = await executeTool(tool, {
      tasks: statusCases.map((statusCase) => ({
        agent: "alpha",
        instruction: `Test ${statusCase.name}`,
      })),
    });
    const text = result.content[0].type === "text" ? result.content[0].text : "";

    expect(text).toContain(`Delegation: 0/${statusCases.length} tasks completed`);
    statusCases.forEach(({ headingStatus }, index) => {
      expect(text).toContain(`### Task ${index + 1} — alpha — ${headingStatus}`);
    });
  });

  it("returns a successful single task answer directly from its exact entry reference", async () => {
    await withSessionFile(
      [
        {
          id: "answer-1",
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Exact delegated answer." }],
          },
        },
        {
          id: "answer-2",
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "A later turn." }],
          },
        },
      ],
      async (sessionPath) => {
        const { tool, executeDelegation } = createTool();
        executeDelegation.mockImplementation(async (tasks) => [
          {
            task: tasks[0],
            outcome: {
              status: "completed",
              request,
              answer: { path: sessionPath, entryId: "answer-1" },
              humanIntervened: false,
            },
          },
        ]);

        const result = await executeTool(tool, {
          tasks: [{ agent: "alpha", instruction: "Review" }],
        });

        expect(result).toEqual({
          content: [{ type: "text", text: `${header}Exact delegated answer.` }],
          details: {
            tasks: [
              {
                taskNumber: 1,
                agent: "alpha",
                status: "completed",
                request,
                answer: { path: sessionPath, entryId: "answer-1" },
                humanIntervened: false,
              },
            ],
          },
        });
      },
    );
  });

  it.each([
    {
      name: "line limit",
      answer: Array.from({ length: 2001 }, (_, index) => `line-${index}`).join("\n"),
      expectedLast: "line-1999",
      excluded: "line-2000",
      notice:
        "[Answer truncated: showing 2000 of 2001 lines (18.4KB of 18.5KB). The full answer remains available in the referenced subagent session entry.]",
    },
    {
      name: "byte limit",
      answer: Array.from({ length: 30 }, (_, index) => `${index}:${"é".repeat(1000)}`).join("\n"),
      expectedLast: `24:${"é".repeat(1000)}`,
      excluded: `25:${"é".repeat(1000)}`,
      notice:
        "[Answer truncated: showing 25 of 30 lines (48.9KB of 58.7KB). The full answer remains available in the referenced subagent session entry.]",
    },
  ])(
    "uses Pi's canonical head truncation at the $name",
    async ({ answer, expectedLast, excluded, notice }) => {
      await withSessionFile(
        [
          {
            id: "answer",
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: answer }],
            },
          },
        ],
        async (sessionPath) => {
          const { tool, executeDelegation } = createTool();
          executeDelegation.mockImplementation(async (tasks) => [
            {
              task: tasks[0],
              outcome: {
                status: "completed",
                request,
                answer: { path: sessionPath, entryId: "answer" },
                humanIntervened: false,
              },
            },
          ]);

          const result = await executeTool(tool, {
            tasks: [{ agent: "alpha", instruction: "Review" }],
          });
          const text = result.content[0].type === "text" ? result.content[0].text : "";

          expect(text).toContain(expectedLast);
          expect(text).not.toContain(excluded);
          expect(text).toContain(notice);
          expect(result.details.tasks[0]).toMatchObject({
            answer: { path: sessionPath, entryId: "answer" },
          });
        },
      );
    },
  );
});

describe("subagent task validation", () => {
  it("executes valid siblings with their original task numbers and merges outcomes by request position", async () => {
    const { tool, executeDelegation } = createTool();
    executeDelegation.mockImplementation(async (tasks) => [
      {
        task: tasks[0],
        outcome: { status: "completed", request, answer: null, humanIntervened: false },
      },
    ]);

    const result = await executeTool(tool, {
      tasks: [
        { agent: " ", instruction: "First" },
        { agent: " alpha ", instruction: " Review ", cwd: " ./raw cwd " },
        { agent: "missing", instruction: "Third" },
      ],
      timeout: 2,
    });

    expect(executeDelegation).toHaveBeenCalledTimes(1);
    expect(executeDelegation.mock.calls[0][0]).toEqual([
      {
        taskNumber: 2,
        agent: "alpha",
        instruction: "Review",
        cwd: " ./raw cwd ",
        config: alphaAgent,
        timeoutMs: 120_000,
      },
    ]);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("Delegation: 1/3 tasks completed");
    expect(text.indexOf("### Task 1 — (empty agent) — invalid")).toBeLessThan(
      text.indexOf("### Task 2 — alpha — completed"),
    );
    expect(text.indexOf("### Task 2 — alpha — completed")).toBeLessThan(
      text.indexOf("### Task 3 — missing — invalid"),
    );
    expect(text).toContain(`${header}The request completed without a final answer.`);
    expect(result.details).toEqual({
      tasks: [
        {
          taskNumber: 1,
          agent: "",
          status: "invalid",
          reason: "empty-agent",
          error: "Agent name must not be empty.",
        },
        {
          taskNumber: 2,
          agent: "alpha",
          status: "completed",
          request,
          answer: null,
          humanIntervened: false,
        },
        {
          taskNumber: 3,
          agent: "missing",
          status: "invalid",
          reason: "unknown-agent",
          error: 'Unknown agent "missing". Available agents:\n  alpha — Alpha agent',
        },
      ],
    });
  });

  it("returns positional invalid outcomes without initializing delegation when every task is invalid", async () => {
    const { tool, executeDelegation } = createTool();

    const result = await executeTool(tool, {
      tasks: [
        { agent: "  ", instruction: "Review" },
        { agent: "alpha", instruction: "\t" },
        { agent: "missing", instruction: "Review" },
      ],
    });

    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("Delegation: 0/3 tasks completed");
    expect(text).toContain("### Task 1 — (empty agent) — invalid");
    expect(text).toContain("### Task 2 — alpha — invalid");
    expect(text).toContain("### Task 3 — missing — invalid");
    expect(result.details).toEqual({
      tasks: [
        {
          taskNumber: 1,
          agent: "",
          status: "invalid",
          reason: "empty-agent",
          error: "Agent name must not be empty.",
        },
        {
          taskNumber: 2,
          agent: "alpha",
          status: "invalid",
          reason: "empty-instruction",
          error: "Instruction must not be empty.",
        },
        {
          taskNumber: 3,
          agent: "missing",
          status: "invalid",
          reason: "unknown-agent",
          error: 'Unknown agent "missing". Available agents:\n  alpha — Alpha agent',
        },
      ],
    });
    expect(executeDelegation).not.toHaveBeenCalled();
  });

  it("forwards the trimmed delegation label, or none, to the delegation call", async () => {
    const { tool, executeDelegation } = createTool();
    executeDelegation.mockImplementation(async (tasks) => [
      {
        task: tasks[0],
        outcome: { status: "completed", request, answer: null, humanIntervened: false },
      },
    ]);

    await executeTool(tool, {
      tasks: [{ agent: "alpha", instruction: "Review" }],
      label: "  review-issue-13  ",
    });
    expect(executeDelegation.mock.calls[0][1]).toMatchObject({ label: "review-issue-13" });

    await executeTool(tool, { tasks: [{ agent: "alpha", instruction: "Review" }] });
    expect(executeDelegation.mock.calls[1][1].label).toBeUndefined();
  });
});

describe("subagent listing", () => {
  it.each([{}, { tasks: [] }])(
    "lists the snapshotted catalog without initializing delegation",
    async (params) => {
      const { tool, executeDelegation } = createTool();

      const result = await executeTool(tool, params);

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Available agents:\n\n  alpha — Alpha agent\n\nProject-local agents are hidden because the parent project is not trusted. Use /trust to trust this project.",
          },
        ],
        details: { tasks: [] },
      });
      expect(executeDelegation).not.toHaveBeenCalled();
    },
  );
});

describe("subagent operator intervention", () => {
  it("leads the answer with a note when the operator interacted with the child", async () => {
    await withSessionFile(
      [
        {
          id: "answer",
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Updated answer." }],
          },
        },
      ],
      async (sessionPath) => {
        const { tool, executeDelegation } = createTool();
        executeDelegation.mockImplementation(async (tasks) => [
          {
            task: tasks[0],
            outcome: {
              status: "completed",
              request,
              answer: { path: sessionPath, entryId: "answer" },
              humanIntervened: true,
            },
          },
        ]);

        const result = await executeTool(tool, {
          tasks: [{ agent: "alpha", instruction: "Review" }],
        });

        expect(result.content).toEqual([
          {
            type: "text",
            text: `${header}The operator also interacted with this child during the request; the answer may address their input.\n\nUpdated answer.`,
          },
        ]);
      },
    );
  });
});

describe("subagent_ask and subagent_retrieve", () => {
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
        result: {
          status: "failed",
          reason: "interrupted",
          error: "stopped",
          humanIntervened: false,
        },
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
      expect(
        Value.Check(retrieveTool.parameters, { childId: "a", requestId: "r1", extra: 1 }),
      ).toBe(false);
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
});
