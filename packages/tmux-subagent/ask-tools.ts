/**
 * ask-tools.ts — `subagent_ask` and `subagent_retrieve` (§9): schemas,
 * timeout conversion, and presentation. The parent runtime does the work.
 */

import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AskOutcome,
  DEFAULT_TURN_TIMEOUT_MINUTES,
  type ParentRuntime,
  type RetrievalOutcome,
  type WaitOptions,
} from "./parent.ts";
import type { ChildId } from "./store.ts";
import { completedText, failedText, retrieveHint, withReference } from "./subagent-tool.ts";

const Timeout = Type.Optional(
  Type.Integer({
    minimum: 1,
    description:
      `Wait timeout in minutes (default: the child's agent timeout, otherwise ${DEFAULT_TURN_TIMEOUT_MINUTES}). ` +
      "On expiry the child keeps working on the request.",
  }),
);

const AskParams = Type.Object(
  {
    childId: Type.String({ description: "Child ID from an earlier subagent result" }),
    instruction: Type.String({ description: "Follow-up instruction for the child" }),
    timeout: Timeout,
  },
  { additionalProperties: false },
);

const RetrieveParams = Type.Object(
  {
    childId: Type.String({ description: "Child ID from an earlier subagent result" }),
    requestId: Type.String({ description: "Request ID from an earlier result, e.g. r2" }),
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
          : failedText(result.reason, result.error);
      return withReference(request, body);
    }
    case "pending":
      return withReference(request, `Still ${outcome.state}. ${retrieveHint(request)}`);
    case "lost":
      return withReference(
        request,
        outcome.started
          ? "The child stopped while working on this request and recorded no result. It may have made changes. It will be marked interrupted, not re-run, when the child next starts."
          : "The child stopped before starting this request. The request is still queued and runs when the child next starts. subagent_ask starts the child but also submits its new instruction.",
      );
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
      onProgress: ({ request, state }) =>
        progress(`Child ${request.childId}, request ${request.requestId}: ${state}`),
    };
  }

  /** Progress updates carry no details; the final result carries the outcome. */
  function progressTo<T>(onUpdate: AgentToolUpdateCallback<T | undefined> | undefined) {
    return (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
  }

  const askTool: ToolDefinition<typeof AskParams, AskOutcome | undefined> = {
    name: "subagent_ask",
    label: "Subagent ask",
    description: [
      "Send a follow-up instruction to one of your existing subagent children and wait for its answer.",
      "A stopped child is resumed first. A child accepts one running and one queued request.",
      "If the wait ends early, the child keeps working; use subagent_retrieve to keep waiting.",
    ].join("\n"),
    parameters: AskParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      const instruction = params.instruction.trim();
      if (!instruction) throw new Error("Instruction must not be empty.");
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
    label: "Subagent retrieve",
    description: [
      "Get the result of an earlier subagent request, waiting for it if it has not settled.",
      "Never starts a child or submits work.",
    ].join("\n"),
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
