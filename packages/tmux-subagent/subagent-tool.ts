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
import {
  DEFAULT_TURN_TIMEOUT_MINUTES,
  type DelegatedTaskExecution,
  type DelegatedTaskOutcome,
  type DelegatedTaskRecord,
  type ExecuteDelegation,
  MAX_DELEGATED_TASKS,
} from "./parent.ts";
import { readAnswer, type SessionAnswerRef } from "./pi-session.ts";
import type { RequestRef } from "./store.ts";

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
        maxItems: MAX_DELEGATED_TASKS,
        description:
          "Array of {agent, instruction, cwd?}. One task runs a single sub-agent; " +
          `multiple tasks run sub-agents in parallel (max ${MAX_DELEGATED_TASKS}). ` +
          "Omit or pass an empty array to list available agents.",
      }),
    ),
    label: Type.Optional(
      Type.String({
        description:
          "Purpose label recorded with each child of this delegation, e.g. review-issue-13.",
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Per-task delegation timeout in minutes (overrides the agent default, otherwise " +
          DEFAULT_TURN_TIMEOUT_MINUTES +
          "). " +
          "On expiry the child keeps working on the request.",
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

const STILL_WORKING = "The child is still working on the request; nothing was stopped.";
const OPERATOR_NOTE =
  "The operator also interacted with this child during the request; the answer may address their input.";

/** How the model keeps waiting on a request whose wait ended early. */
export function retrieveHint(request: RequestRef): string {
  return `Use subagent_retrieve with childId ${request.childId} and requestId ${request.requestId} to keep waiting.`;
}

/** The `Child <childId>, request <requestId>` line every referenced outcome starts with. */
export function withReference(request: RequestRef, body: string): string {
  return `Child ${request.childId}, request ${request.requestId}\n\n${body}`;
}

/** A completed request's answer, resolved from its reference at presentation time. */
export function completedText(
  answerRef: SessionAnswerRef | null,
  humanIntervened: boolean,
): string {
  const answer = answerRef ? readAnswer(answerRef) : null;
  const text =
    answer === null ? "The request completed without a final answer." : truncateAnswer(answer);
  return humanIntervened ? `${OPERATOR_NOTE}\n\n${text}` : text;
}

export function failedText(reason: "error" | "interrupted" | "superseded", error: string): string {
  const text = `Request failed (${reason}): ${error}`;
  return reason === "interrupted"
    ? `${text}\nNo result was recorded. The child may have made changes. The request will not be retried automatically.`
    : text;
}

function truncateAnswer(answer: string): string {
  const truncation = truncateHead(answer, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return truncation.content;
  const separator = truncation.content ? "\n\n" : "";
  return `${truncation.content}${separator}[Answer truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). The full answer remains available in the referenced subagent session entry.]`;
}

function minutes(count: number): string {
  return `${count} ${count === 1 ? "minute" : "minutes"}`;
}

/** Model-facing text for one outcome, before its request reference line. */
function outcomeBody(
  task: ParsedTask | DelegatedTaskRecord,
  outcome: TaskResult["outcome"],
): string {
  switch (outcome.status) {
    case "invalid":
      return outcome.error;
    case "completed":
      return completedText(outcome.answer, outcome.humanIntervened);
    case "failed":
      return failedText(outcome.reason, outcome.error);
    case "timed_out": {
      const timeoutMs = "timeoutMs" in task ? task.timeoutMs : undefined;
      const timeoutMinutes =
        timeoutMs !== undefined ? timeoutMs / 60_000 : DEFAULT_TURN_TIMEOUT_MINUTES;
      return `The wait timed out after ${minutes(timeoutMinutes)}. ${STILL_WORKING} ${retrieveHint(outcome.request)}`;
    }
    case "aborted":
      return outcome.stage === "before_launch"
        ? "The delegated task was aborted before launch. No child was created."
        : `The wait was aborted. ${STILL_WORKING} ${retrieveHint(outcome.request)}`;
    case "session_closed":
      return "The child stopped before recording a result for this request. It may have made changes.";
    case "launch_failed":
      return outcome.childId
        ? `Child ${outcome.childId} could not be launched: ${outcome.error}`
        : `The subagent could not be launched: ${outcome.error}`;
    case "launch_indeterminate":
      return `The child did not confirm it started: ${outcome.error} The request is on disk and may still run.`;
    case "observation_failed":
      return `Observation failed: ${outcome.error}. The child may still be running the request.`;
  }
}

/** Every outcome with a request reference names it, so the model can quote it. */
function outcomeText(
  task: ParsedTask | DelegatedTaskRecord,
  outcome: TaskResult["outcome"],
): string {
  const body = outcomeBody(task, outcome);
  return "request" in outcome ? withReference(outcome.request, body) : body;
}

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
      "Delegate work to a sub-agent for tasks matching one of the specialised agents below.",
      "Each sub-agent runs as an interactive Pi child session that keeps its conversation after the task.",
      "",
      "Call with no arguments to list available agents.",
      "",
      "Usage:",
      "  {}                                                -> list agents",
      '  {tasks: [{agent:"foo", instruction:"..."}]}        -> single sub-agent',
      '  {tasks: [{agent:"foo", instruction:"..."}, ...]}   -> parallel sub-agents',
      "  label: optional purpose label recorded with each child",
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
      const label = params.label?.trim() || undefined;
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
        validTasks.push({
          ...task,
          config,
          timeoutMs: (params.timeout ?? config.timeout ?? DEFAULT_TURN_TIMEOUT_MINUTES) * 60 * 1000,
        });
      }

      if (validTasks.length > 0) {
        const executions = await options.executeDelegation(validTasks, {
          label,
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
      const resultTexts = results.map(({ task, outcome }) => outcomeText(task, outcome));
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
