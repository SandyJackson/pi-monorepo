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
import * as text from "./model-text.ts";
import {
  DEFAULT_TURN_TIMEOUT_MINUTES,
  type DelegatedTaskExecution,
  type DelegatedTaskOutcome,
  type DelegatedTaskRecord,
  type ExecuteDelegation,
  MAX_DELEGATED_TASKS,
} from "./parent.ts";
import { readAnswer, type SessionAnswerRef } from "./pi-session.ts";

const TaskItem = Type.Object(
  {
    agent: Type.String({ description: text.TASK_AGENT_PARAM }),
    instruction: Type.String({ description: text.TASK_INSTRUCTION_PARAM }),
    cwd: Type.Optional(Type.String({ description: text.TASK_CWD_PARAM })),
  },
  { additionalProperties: false },
);

const SubagentParams = Type.Object(
  {
    tasks: Type.Optional(
      Type.Array(TaskItem, {
        maxItems: MAX_DELEGATED_TASKS,
        description: text.tasksParam(MAX_DELEGATED_TASKS),
      }),
    ),
    label: Type.Optional(Type.String({ description: text.LABEL_PARAM })),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: text.delegationTimeoutParam(DEFAULT_TURN_TIMEOUT_MINUTES),
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

/** A completed request's answer, resolved from its reference at presentation time. */
export function completedText(
  answerRef: SessionAnswerRef | null,
  humanIntervened: boolean,
): string {
  const answer = answerRef ? readAnswer(answerRef) : null;
  const body = answer === null ? text.NO_FINAL_ANSWER : truncateAnswer(answer);
  return humanIntervened ? text.withOperatorNote(body) : body;
}

function truncateAnswer(answer: string): string {
  const truncation = truncateHead(answer, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return truncation.content;
  return text.answerTruncated(
    truncation.content,
    truncation.outputLines,
    truncation.totalLines,
    formatSize(truncation.outputBytes),
    formatSize(truncation.totalBytes),
  );
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
      return text.failedText(outcome.reason, outcome.error);
    case "timed_out": {
      const timeoutMs = "timeoutMs" in task ? task.timeoutMs : undefined;
      const timeoutMinutes =
        timeoutMs !== undefined ? timeoutMs / 60_000 : DEFAULT_TURN_TIMEOUT_MINUTES;
      return text.waitTimedOut(timeoutMinutes, outcome.request);
    }
    case "aborted":
      return outcome.stage === "before_launch"
        ? text.ABORTED_BEFORE_LAUNCH
        : text.waitAborted(outcome.request);
    case "session_closed":
      return text.SESSION_CLOSED;
    case "launch_failed":
      return outcome.childId
        ? text.childLaunchFailed(outcome.childId, outcome.error)
        : text.subagentLaunchFailed(outcome.error);
    case "launch_indeterminate":
      return text.launchIndeterminate(outcome.error);
    case "observation_failed":
      return text.observationFailed(outcome.error);
  }
}

/** Every outcome with a request reference names it, so the model can quote it. */
function outcomeText(
  task: ParsedTask | DelegatedTaskRecord,
  outcome: TaskResult["outcome"],
): string {
  const body = outcomeBody(task, outcome);
  return "request" in outcome ? text.withReference(outcome.request, body) : body;
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
      ? text.availableAgentsSuffix(formatMergedAgentList([...options.agents]))
      : "";
  const description = text.SUBAGENT_DESCRIPTION + agentsSuffix;

  return {
    name: "subagent",
    label: text.SUBAGENT_LABEL,
    description,
    parameters: SubagentParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
    ) {
      if (!params.tasks || params.tasks.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: text.availableAgents(
                formatMergedAgentList([...options.agents]),
                !options.includeProjectAgents,
              ),
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
              error: text.AGENT_NAME_EMPTY,
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
              error: text.INSTRUCTION_EMPTY,
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
              content: [{ type: "text", text: text.taskProgress(update.taskNumber, update.line) }],
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
        if (!result) throw new Error(text.noOutcomeForTask(task.taskNumber));
        return result;
      });
      const completedCount = results.filter(({ outcome }) => outcome.status === "completed").length;
      const resultTexts = results.map(({ task, outcome }) => outcomeText(task, outcome));
      const sections = results.map(({ task, outcome }, index) => {
        const headingStatus = outcome.status.replaceAll("_", " ");
        return text.taskSection(task.taskNumber, task.agent, headingStatus, resultTexts[index]);
      });
      const resultText =
        results.length === 1
          ? resultTexts[0]
          : text.delegationSummary(completedCount, parsedTasks.length, sections);
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
