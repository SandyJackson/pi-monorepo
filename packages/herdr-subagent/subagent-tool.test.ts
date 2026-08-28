import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents.js";
import type { DelegatedTaskOutcome } from "./herdr/session.js";
import { createSubagentTool, type ExecuteDelegation } from "./subagent-tool.js";

const alphaAgent: AgentConfig = {
  name: "alpha",
  description: "Alpha agent",
  systemPromptBody: "",
  source: "user",
  sourceDir: "/agents",
  filePath: "/agents/alpha.md",
};

function createTool() {
  const executeDelegation = vi.fn<ExecuteDelegation>();
  const tool = createSubagentTool({
    agents: [alphaAgent],
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

const session = { paneId: "pane-1", label: "sa-alpha" };

const statusCases: Array<{
  name: string;
  outcome: DelegatedTaskOutcome;
  timeout?: number;
  headingStatus: string;
  text: string;
  expectedOutcomeDetails: Record<string, unknown>;
}> = [
  {
    name: "timeout",
    outcome: { status: "timed_out", session },
    timeout: 3,
    headingStatus: "timed out",
    text: "The delegated turn timed out after 3 minutes. The visible session remains available in pane pane-1.",
    expectedOutcomeDetails: { status: "timed_out", session },
  },
  {
    name: "abort before launch",
    outcome: { status: "aborted", stage: "before_launch" },
    headingStatus: "aborted",
    text: "The delegated task was aborted before launch. No visible subagent session was started.",
    expectedOutcomeDetails: { status: "aborted", stage: "before_launch" },
  },
  {
    name: "abort while observing",
    outcome: { status: "aborted", stage: "observing", session },
    headingStatus: "aborted",
    text: "The delegated turn was aborted while observing. The visible session remains available in pane pane-1.",
    expectedOutcomeDetails: { status: "aborted", stage: "observing", session },
  },
  {
    name: "session closure",
    outcome: { status: "session_closed", session },
    headingStatus: "session closed",
    text: "The visible subagent session in pane pane-1 closed before the delegated turn completed.",
    expectedOutcomeDetails: { status: "session_closed", session },
  },
  {
    name: "confirmed launch failure",
    outcome: { status: "launch_failed", error: "launch denied" },
    headingStatus: "launch failed",
    text: "The subagent could not be launched: launch denied",
    expectedOutcomeDetails: { status: "launch_failed", error: "launch denied" },
  },
  {
    name: "indeterminate launch",
    outcome: {
      status: "launch_indeterminate",
      error: "socket closed",
      possiblePaneId: "possible-pane",
    },
    headingStatus: "launch indeterminate",
    text: "Herdr may have launched this session in pane possible-pane. Inspect the possible pane before retrying. socket closed",
    expectedOutcomeDetails: {
      status: "launch_indeterminate",
      error: "socket closed",
      possiblePaneId: "possible-pane",
    },
  },
  {
    name: "observation failure",
    outcome: { status: "observation_failed", session, error: "invalid response" },
    headingStatus: "observation failed",
    text: "Observation failed for pane pane-1: invalid response. The visible session may still be live.",
    expectedOutcomeDetails: { status: "observation_failed", session, error: "invalid response" },
  },
];

describe("subagent result presentation", () => {
  it.each(statusCases)(
    "presents $name with precise text and normalized details",
    async ({ outcome, timeout, text, expectedOutcomeDetails }) => {
      const { tool, executeDelegation } = createTool();
      executeDelegation.mockImplementation(async (tasks) => [{ task: tasks[0], outcome }]);

      const result = await executeTool(tool, {
        tasks: [{ agent: "alpha", instruction: "Review" }],
        timeout,
      });

      expect(result).toEqual({
        content: [{ type: "text", text }],
        details: {
          tasks: [{ taskNumber: 1, agent: "alpha", ...expectedOutcomeDetails }],
        },
      });
    },
  );
  it("tells the model to inspect the visible session when a completed single task has no answer", async () => {
    const { tool, executeDelegation } = createTool();
    executeDelegation.mockImplementation(async (tasks) => [
      {
        task: tasks[0],
        outcome: { status: "completed", session, answer: null },
      },
    ]);

    const result = await executeTool(tool, {
      tasks: [{ agent: "alpha", instruction: "Review" }],
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "The delegated turn completed without a final answer. Inspect the visible session in pane pane-1.",
        },
      ],
      details: {
        tasks: [{ taskNumber: 1, agent: "alpha", status: "completed", session, answer: null }],
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
              session: { paneId: "pane-1", label: "sa-alpha" },
              answer: { path: sessionPath, entryId: "answer-1" },
            },
          },
        ]);

        const result = await executeTool(tool, {
          tasks: [{ agent: "alpha", instruction: "Review" }],
        });

        expect(result).toEqual({
          content: [{ type: "text", text: "Exact delegated answer." }],
          details: {
            tasks: [
              {
                taskNumber: 1,
                agent: "alpha",
                status: "completed",
                session: { paneId: "pane-1", label: "sa-alpha" },
                answer: { path: sessionPath, entryId: "answer-1" },
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
                session: { paneId: "pane-1", label: "sa-alpha" },
                answer: { path: sessionPath, entryId: "answer" },
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
        outcome: {
          status: "completed",
          session: { paneId: "pane-2", label: "sa-alpha-review" },
          answer: null,
        },
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
      },
    ]);
    expect(executeDelegation.mock.calls[0][1]).toMatchObject({ timeoutMs: 120_000 });
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("Delegation: 1/3 tasks completed");
    expect(text.indexOf("### Task 1 — (empty agent) — invalid")).toBeLessThan(
      text.indexOf("### Task 2 — alpha — completed"),
    );
    expect(text.indexOf("### Task 2 — alpha — completed")).toBeLessThan(
      text.indexOf("### Task 3 — missing — invalid"),
    );
    expect(text).toContain(
      "The delegated turn completed without a final answer. Inspect the visible session in pane pane-2.",
    );
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
          session: { paneId: "pane-2", label: "sa-alpha-review" },
          answer: null,
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
