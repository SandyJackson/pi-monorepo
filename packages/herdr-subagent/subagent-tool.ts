import {
  type AgentToolUpdateCallback,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ToolDefinition,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AgentConfig,
  type AgentScope,
  formatMergedAgentList,
  resolveAgent,
} from "./agents.ts";
import type { DelegatedTaskExecution, DelegatedTaskRecord } from "./herdr/delegation.ts";
import type { DelegatedTaskOutcome } from "./herdr/session.ts";
import { readAnswer } from "./pi-session.ts";

const TaskItem = Type.Object(
  {
    agent: Type.String({ description: "Name of the agent to invoke" }),
    instruction: Type.String({ description: "Instruction to delegate to the agent" }),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for the agent process (default: parent session cwd)",
      }),
    ),
  },
  { additionalProperties: false },
);

const SubagentParams = Type.Object(
  {
    tasks: Type.Optional(
      Type.Array(TaskItem, {
        maxItems: 8,
        description:
          "Array of {agent, instruction, cwd?}. One task runs a single visible sub-agent; " +
          "multiple tasks run visible sub-agents in parallel (max 8). " +
          "Omit or pass an empty array to list available agents.",
      }),
    ),
    label: Type.Optional(
      Type.String({
        description:
          "Purpose label naming this delegation's tab, e.g. review-issue-13. " +
          "It names the whole delegation's tab, not an individual agent or pane. " +
          "Defaults to the delegated agents' names.",
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Per-task delegation timeout in minutes (default: 20). " +
          "On expiry the child pane is left running for manual inspection.",
      }),
    ),
  },
  { additionalProperties: false },
);

type InvalidReason = "empty-agent" | "empty-instruction" | "unknown-agent";

type InvalidTaskOutcome = {
  status: "invalid";
  reason: InvalidReason;
  error: string;
};

type NormalizedTaskDetail = {
  taskNumber: number;
  agent: string;
} & (InvalidTaskOutcome | DelegatedTaskOutcome);

interface SubagentToolDetails {
  tasks: NormalizedTaskDetail[];
}

interface ParsedTask {
  taskNumber: number;
  agent: string;
  instruction: string;
  cwd: string;
}

interface InvalidTaskResult {
  task: ParsedTask;
  outcome: InvalidTaskOutcome;
}

type TaskResult = InvalidTaskResult | DelegatedTaskExecution;

function truncateAnswer(answer: string): string {
  const truncation = truncateHead(answer, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return truncation.content;
  const separator = truncation.content ? "\n\n" : "";
  return `${truncation.content}${separator}[Answer truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). The full answer remains available in the referenced subagent session entry.]`;
}

export type ExecuteDelegation = (
  tasks: readonly DelegatedTaskRecord[],
  options: {
    timeoutMs: number;
    /** Purpose label for the delegation's tab; the delegation falls back to agent names. */
    label?: string;
    signal?: AbortSignal;
    onProgress?: (update: { taskNumber: number; line: string }) => void;
  },
) => Promise<DelegatedTaskExecution[]>;

interface CreateSubagentToolOptions {
  agents: readonly AgentConfig[];
  parentCwd: string;
  includeProjectAgents: boolean;
  executeDelegation: ExecuteDelegation;
}

export function createSubagentTool(
  options: CreateSubagentToolOptions,
): ToolDefinition<typeof SubagentParams, SubagentToolDetails> {
  const agentsSuffix =
    options.agents.length > 0
      ? `\nAvailable agents:\n${formatMergedAgentList([...options.agents])}`
      : "";
  const description =
    [
      "Delegate work to a visible sub-agent for tasks matching one of the specialised agents below.",
      "The sub-agent opens as a real interactive pane you can watch and later take over.",
      "",
      "Call with no arguments to list available agents.",
      "",
      "Usage:",
      "  {}                                                -> list agents",
      '  {tasks: [{agent:"foo", instruction:"..."}]}        -> single visible sub-agent',
      '  {tasks: [{agent:"foo", instruction:"..."}, ...]}   -> parallel visible sub-agents',
      "  label: optional tab label for this delegation (default: agent names)",
      "  timeout: per-task timeout in minutes",
    ].join("\n") + agentsSuffix;

  return {
    name: "subagent",
    label: "Subagent",
    description,
    parameters: SubagentParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
    ) {
      if (!params.tasks || params.tasks.length === 0) {
        const trustNote = options.includeProjectAgents
          ? ""
          : "\n\nProject-local agents are hidden because the parent project is not trusted. Use /trust to trust this project.";
        return {
          content: [
            {
              type: "text",
              text: `Available agents:\n\n${formatMergedAgentList([...options.agents])}${trustNote}`,
            },
          ],
          details: { tasks: [] },
        };
      }

      const parsedTasks: ParsedTask[] = params.tasks.map((task, index) => ({
        taskNumber: index + 1,
        agent: task.agent.trim(),
        instruction: task.instruction.trim(),
        cwd: task.cwd ?? options.parentCwd,
      }));
      const tabLabel = params.label?.trim();
      const scope: AgentScope = options.includeProjectAgents ? "both" : "user";
      const resultsByTaskNumber = new Map<number, TaskResult>();
      const validTasks: DelegatedTaskRecord[] = [];
      for (const task of parsedTasks) {
        if (!task.agent) {
          resultsByTaskNumber.set(task.taskNumber, {
            task,
            outcome: {
              status: "invalid",
              reason: "empty-agent",
              error: "Agent name must not be empty.",
            },
          });
          continue;
        }
        if (!task.instruction) {
          resultsByTaskNumber.set(task.taskNumber, {
            task,
            outcome: {
              status: "invalid",
              reason: "empty-instruction",
              error: "Instruction must not be empty.",
            },
          });
          continue;
        }
        const config = resolveAgent(task.agent, [...options.agents], scope);
        if ("error" in config) {
          resultsByTaskNumber.set(task.taskNumber, {
            task,
            outcome: { status: "invalid", reason: "unknown-agent", error: config.error },
          });
          continue;
        }
        validTasks.push({ ...task, config });
      }

      if (validTasks.length > 0) {
        const executions = await options.executeDelegation(validTasks, {
          timeoutMs: (params.timeout ?? 20) * 60 * 1000,
          label: tabLabel,
          signal: _signal,
          onProgress: (update) => {
            _onUpdate?.({
              content: [{ type: "text", text: `Task ${update.taskNumber}: ${update.line}` }],
              details: { tasks: [] },
            });
          },
        });
        for (const execution of executions) {
          resultsByTaskNumber.set(execution.task.taskNumber, execution);
        }
      }

      const results = parsedTasks.map((task) => {
        const result = resultsByTaskNumber.get(task.taskNumber);
        if (!result) throw new Error(`Delegation returned no outcome for task ${task.taskNumber}.`);
        return result;
      });
      const completedCount = results.filter(({ outcome }) => outcome.status === "completed").length;
      const timeoutMinutes = params.timeout ?? 20;
      // biome-ignore lint/suspicious/useIterableCallbackReturn: switch is exhaustive over the status union; the ": string" annotation makes a missed case a compile error
      const resultTexts = results.map(({ outcome }): string => {
        switch (outcome.status) {
          case "invalid":
            return outcome.error;
          case "completed": {
            const answer = outcome.answer ? readAnswer(outcome.answer) : null;
            return answer === null
              ? `The delegated turn completed without a final answer. Inspect the visible session in pane ${outcome.session.paneId}.`
              : truncateAnswer(answer);
          }
          case "timed_out":
            return `The delegated turn timed out after ${timeoutMinutes} ${timeoutMinutes === 1 ? "minute" : "minutes"}. The visible session remains available in pane ${outcome.session.paneId}.`;
          case "aborted":
            return outcome.stage === "before_launch"
              ? "The delegated task was aborted before launch. No visible subagent session was started."
              : `The delegated turn was aborted while observing. The visible session remains available in pane ${outcome.session.paneId}.`;
          case "session_closed":
            return `The visible subagent session in pane ${outcome.session.paneId} closed before the delegated turn completed.`;
          case "launch_failed":
            return `The subagent could not be launched: ${outcome.error}`;
          case "launch_indeterminate":
            return `Herdr may have launched this session in pane ${outcome.possiblePaneId}. Inspect the possible pane before retrying. ${outcome.error}`;
          case "observation_failed":
            return `Observation failed for pane ${outcome.session.paneId}: ${outcome.error}. The visible session may still be live.`;
        }
      });
      const sections = results.map(({ task, outcome }, index) => {
        const headingStatus = outcome.status.replaceAll("_", " ");
        return `### Task ${task.taskNumber} — ${task.agent || "(empty agent)"} — ${headingStatus}\n\n${resultTexts[index]}`;
      });
      const resultText =
        results.length === 1
          ? resultTexts[0]
          : `Delegation: ${completedCount}/${parsedTasks.length} tasks completed\n\n${sections.join("\n\n---\n\n")}`;
      return {
        content: [{ type: "text", text: resultText }],
        details: {
          tasks: results.map(({ task, outcome }) => ({
            taskNumber: task.taskNumber,
            agent: task.agent,
            ...outcome,
          })),
        },
      };
    },
  };
}
