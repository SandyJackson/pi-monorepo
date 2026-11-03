/**
 * ask-tools.ts — `subagent_ask` and `subagent_retrieve` (§9): schemas,
 * timeout conversion, and presentation. The parent runtime does the work.
 */

import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as text from "./model-text.ts";
import {
  type AskOutcome,
  DEFAULT_TURN_TIMEOUT_MINUTES,
  type ParentRuntime,
  type RetrievalOutcome,
  type WaitOptions,
} from "./parent.ts";
import type { ChildId } from "./store.ts";
import { completedText } from "./subagent-tool.ts";

const Timeout = Type.Optional(
  Type.Integer({
    minimum: 1,
    description: text.waitTimeoutParam(DEFAULT_TURN_TIMEOUT_MINUTES),
  }),
);

const AskParams = Type.Object(
  {
    childId: Type.String({ description: text.CHILD_ID_PARAM }),
    instruction: Type.String({ description: text.FOLLOW_UP_INSTRUCTION_PARAM }),
    timeout: Timeout,
  },
  { additionalProperties: false },
);

const RetrieveParams = Type.Object(
  {
    childId: Type.String({ description: text.CHILD_ID_PARAM }),
    requestId: Type.String({ description: text.REQUEST_ID_PARAM }),
    timeout: Timeout,
  },
  { additionalProperties: false },
);

/** Model-facing text for one retrieval outcome (§9). */
export function retrievalText(outcome: RetrievalOutcome): string {
  const { request } = outcome;
  switch (outcome.status) {
    case "settled": {
      const { result } = outcome;
      const body =
        result.status === "completed"
          ? completedText(result.answer, result.humanIntervened)
          : text.failedText(result.reason, result.error);
      return text.withReference(request, body);
    }
    case "pending":
      return text.withReference(request, text.stillPending(request, outcome.state));
    case "lost":
      return text.withReference(request, outcome.started ? text.LOST_STARTED : text.LOST_QUEUED);
  }
}

function askText(outcome: AskOutcome): string {
  return outcome.status === "rejected" ? outcome.error : retrievalText(outcome.retrieval);
}

function textResult<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createFollowUpTools(options: {
  ask: ParentRuntime["ask"];
  retrieveResult: ParentRuntime["retrieveResult"];
  /** The child's agent timeout in minutes, when it has one. */
  defaultTimeoutMinutes: (childId: ChildId) => number | undefined;
}): [
  ToolDefinition<typeof AskParams, AskOutcome | undefined>,
  ToolDefinition<typeof RetrieveParams, RetrievalOutcome | undefined>,
] {
  function waitOptions(
    childId: ChildId,
    timeout: number | undefined,
    signal: AbortSignal | undefined,
    progress: (text: string) => void,
  ): WaitOptions {
    const minutes =
      timeout ?? options.defaultTimeoutMinutes(childId) ?? DEFAULT_TURN_TIMEOUT_MINUTES;
    return {
      timeoutMs: minutes * 60_000,
      signal,
      onProgress: ({ request, state }) => progress(text.requestProgress(request, state)),
    };
  }

  /** Progress updates carry no details; the final result carries the outcome. */
  function progressTo<T>(onUpdate: AgentToolUpdateCallback<T | undefined> | undefined) {
    return (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
  }

  const askTool: ToolDefinition<typeof AskParams, AskOutcome | undefined> = {
    name: "subagent_ask",
    label: text.ASK_LABEL,
    description: text.ASK_DESCRIPTION,
    parameters: AskParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      const instruction = params.instruction.trim();
      if (!instruction) throw new Error(text.INSTRUCTION_EMPTY);
      const outcome = await options.ask(
        params.childId,
        instruction,
        waitOptions(params.childId, params.timeout, signal, progressTo(onUpdate)),
      );
      return textResult(askText(outcome), outcome);
    },
  };

  const retrieveTool: ToolDefinition<typeof RetrieveParams, RetrievalOutcome | undefined> = {
    name: "subagent_retrieve",
    label: text.RETRIEVE_LABEL,
    description: text.RETRIEVE_DESCRIPTION,
    parameters: RetrieveParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      const outcome = await options.retrieveResult(
        { childId: params.childId, requestId: params.requestId },
        waitOptions(params.childId, params.timeout, signal, progressTo(onUpdate)),
      );
      return textResult(retrievalText(outcome), outcome);
    },
  };

  return [askTool, retrieveTool];
}
