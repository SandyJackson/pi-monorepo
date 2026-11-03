/**
 * model-text.ts — every string shown to the model: tool labels and
 * descriptions, parameter descriptions, results, rejections, errors, and the
 * report envelope. A leaf module: it imports types only.
 *
 * Tool names stay in the tool definitions. Raw system messages (tmux stderr,
 * fs errors) and record-validation errors (`Invalid <file>: …` from store.ts)
 * arrive here as values.
 */

import type { AgentScope } from "./agents.ts";
import type { ReportRecord, RequestRef } from "./store.ts";

// ---------------------------------------------------------------------------
// Shared by every outcome that names a request
// ---------------------------------------------------------------------------

// subagent-tool.ts outcomeText() and ask-tools.ts retrievalText(): the line every referenced outcome starts with
export function withReference(request: RequestRef, body: string): string {
  return `Child ${request.childId}, request ${request.requestId}\n\n${body}`;
}

// waitTimedOut(), waitAborted() and stillPending() below: how the model keeps waiting on a request whose wait ended early
function retrieveHint(request: RequestRef): string {
  return `Use subagent_retrieve with childId ${request.childId} and requestId ${request.requestId} to keep waiting.`;
}

// waitTimedOut() and waitAborted() below: the wait ended early but the child keeps going
const STILL_WORKING = "The child is still working on the request; nothing was stopped.";

// subagent-tool.ts completedText(): a completed request whose run produced no final answer
export const NO_FINAL_ANSWER = "The request completed without a final answer.";

// subagent-tool.ts completedText(): the operator typed into the child during the request
export function withOperatorNote(text: string): string {
  return `The operator also interacted with this child during the request; the answer may address their input.\n\n${text}`;
}

// subagent-tool.ts truncateAnswer(): an answer cut to Pi's output limits
export function answerTruncated(
  content: string,
  outputLines: number,
  totalLines: number,
  outputSize: string,
  totalSize: string,
): string {
  const separator = content ? "\n\n" : "";
  return `${content}${separator}[Answer truncated: showing ${outputLines} of ${totalLines} lines (${outputSize} of ${totalSize}). The full answer remains available in the referenced subagent session entry.]`;
}

// subagent-tool.ts outcomeBody() and ask-tools.ts retrievalText(): a request the child settled as failed
export function failedText(reason: "error" | "interrupted" | "superseded", error: string): string {
  const text = `Request failed (${reason}): ${error}`;
  return reason === "interrupted"
    ? `${text}\nNo result was recorded. The child may have made changes. The request will not be retried automatically.`
    : text;
}

// parent.ts delegate() and ask-tools.ts waitOptions(): a progress line when a request changes state
export function requestProgress(request: RequestRef, state: string): string {
  return `Child ${request.childId}, request ${request.requestId}: ${state}`;
}

// subagent-tool.ts createSubagentTool() and ask-tools.ts askTool: an instruction that is empty after trimming
export const INSTRUCTION_EMPTY = "Instruction must not be empty.";

// ---------------------------------------------------------------------------
// subagent tool
// ---------------------------------------------------------------------------

// subagent-tool.ts TaskItem: the `agent` parameter
export const TASK_AGENT_PARAM = "Name of the agent to invoke";

// subagent-tool.ts TaskItem: the `instruction` parameter
export const TASK_INSTRUCTION_PARAM = "Instruction to delegate to the agent";

// subagent-tool.ts TaskItem: the `cwd` parameter
export const TASK_CWD_PARAM =
  "Working directory for the agent process (default: parent session cwd)";

// subagent-tool.ts SubagentParams: the `tasks` parameter
export function tasksParam(maxTasks: number): string {
  return (
    "Array of {agent, instruction, cwd?}. One task runs a single sub-agent; " +
    `multiple tasks run sub-agents in parallel (max ${maxTasks}). ` +
    "Omit or pass an empty array to list available agents."
  );
}

// subagent-tool.ts SubagentParams: the `label` parameter
export const LABEL_PARAM =
  "Purpose label recorded with each child of this delegation, e.g. review-issue-13.";

// subagent-tool.ts SubagentParams: the `timeout` parameter
export function delegationTimeoutParam(defaultMinutes: number): string {
  return (
    "Per-task delegation timeout in minutes (overrides the agent default, otherwise " +
    defaultMinutes +
    "). " +
    "On expiry the child keeps working on the request."
  );
}

// subagent-tool.ts createSubagentTool(): the tool label
export const SUBAGENT_LABEL = "Subagent";

// subagent-tool.ts createSubagentTool(): the tool description, before the agent list
export const SUBAGENT_DESCRIPTION = [
  "Delegate work to a sub-agent. Available agent types are below.",
  "Agents remain available after completion for follow-up queries or actions.",
  "",
  "Call with no arguments to list available agents.",
  "",
  "Usage:",
  "  {}                                                -> list agents",
  '  {tasks: [{agent:"foo", instruction:"..."}]}        -> single sub-agent',
  '  {tasks: [{agent:"foo", instruction:"..."}, ...]}   -> parallel sub-agents',
  "  label: optional purpose label recorded with each child",
  "  timeout: per-task timeout in minutes",
].join("\n");

// subagent-tool.ts createSubagentTool(): the agent list appended to the description
export function availableAgentsSuffix(agentList: string): string {
  return `\nAvailable agents:\n${agentList}`;
}

// subagent-tool.ts createSubagentTool(): the result of a call with no tasks
export function availableAgents(agentList: string, projectAgentsHidden: boolean): string {
  const trustNote = projectAgentsHidden
    ? "\n\nProject-local agents are hidden because the parent project is not trusted. Use /trust to trust this project."
    : "";
  return `Available agents:\n\n${agentList}${trustNote}`;
}

// subagent-tool.ts createSubagentTool(): a task with an empty agent name
export const AGENT_NAME_EMPTY = "Agent name must not be empty.";

// subagent-tool.ts createSubagentTool(): a progress update for one task
export function taskProgress(taskNumber: number, line: string): string {
  return `Task ${taskNumber}: ${line}`;
}

// subagent-tool.ts createSubagentTool(): the delegation runtime returned no outcome for a task
export function noOutcomeForTask(taskNumber: number): string {
  return `Delegation returned no outcome for task ${taskNumber}.`;
}

// subagent-tool.ts createSubagentTool(): one task's section in a multi-task result
export function taskSection(
  taskNumber: number,
  agent: string,
  status: string,
  body: string,
): string {
  return `### Task ${taskNumber} — ${agent || "(empty agent)"} — ${status}\n\n${body}`;
}

// subagent-tool.ts createSubagentTool(): a multi-task result
export function delegationSummary(completed: number, total: number, sections: string[]): string {
  return `Delegation: ${completed}/${total} tasks completed\n\n${sections.join("\n\n---\n\n")}`;
}

// waitTimedOut() below: a minute count with its unit
function minutes(count: number): string {
  return `${count} ${count === 1 ? "minute" : "minutes"}`;
}

// subagent-tool.ts outcomeBody(): timed_out
export function waitTimedOut(timeoutMinutes: number, request: RequestRef): string {
  return `The wait timed out after ${minutes(timeoutMinutes)}. ${STILL_WORKING} ${retrieveHint(request)}`;
}

// subagent-tool.ts outcomeBody(): aborted before launch
export const ABORTED_BEFORE_LAUNCH =
  "The delegated task was aborted before launch. No child was created.";

// subagent-tool.ts outcomeBody(): aborted while observing
export function waitAborted(request: RequestRef): string {
  return `The wait was aborted. ${STILL_WORKING} ${retrieveHint(request)}`;
}

// subagent-tool.ts outcomeBody(): session_closed
export const SESSION_CLOSED =
  "The child stopped before recording a result for this request. It may have made changes.";

// subagent-tool.ts outcomeBody(): launch_failed after the child record exists
export function childLaunchFailed(childId: string, error: string): string {
  return `Child ${childId} could not be launched: ${error}`;
}

// subagent-tool.ts outcomeBody(): launch_failed before the child record exists
export function subagentLaunchFailed(error: string): string {
  return `The subagent could not be launched: ${error}`;
}

// subagent-tool.ts outcomeBody(): launch_indeterminate
export function launchIndeterminate(error: string): string {
  return `The child did not confirm it started: ${error} The request is on disk and may still run.`;
}

// subagent-tool.ts outcomeBody(): observation_failed
export function observationFailed(error: string): string {
  return `Observation failed: ${error}. The child may still be running the request.`;
}

// ---------------------------------------------------------------------------
// subagent_ask and subagent_retrieve tools
// ---------------------------------------------------------------------------

// ask-tools.ts Timeout: the `timeout` parameter of both tools
export function waitTimeoutParam(defaultMinutes: number): string {
  return (
    `Wait timeout in minutes (default: the child's agent timeout, otherwise ${defaultMinutes}). ` +
    "On expiry the child keeps working on the request."
  );
}

// ask-tools.ts AskParams and RetrieveParams: the `childId` parameter
export const CHILD_ID_PARAM = "Child ID from an earlier subagent result";

// ask-tools.ts AskParams: the `instruction` parameter
export const FOLLOW_UP_INSTRUCTION_PARAM = "Follow-up instruction for the child";

// ask-tools.ts RetrieveParams: the `requestId` parameter
export const REQUEST_ID_PARAM = "Request ID from an earlier result, e.g. r2";

// ask-tools.ts askTool: the tool label
export const ASK_LABEL = "Subagent ask";

// ask-tools.ts askTool: the tool description
export const ASK_DESCRIPTION = [
  "Send a follow-up instruction to one of your existing subagent children and wait for its answer.",
  "A child accepts one running and one queued request.",
].join("\n");

// ask-tools.ts retrieveTool: the tool label
export const RETRIEVE_LABEL = "Subagent retrieve";

// ask-tools.ts retrieveTool: the tool description
export const RETRIEVE_DESCRIPTION = [
  "Get the result of an earlier subagent request, waiting for it if it has not settled.",
  "Use if the wait ended early. Never starts a child or submits work.",
].join("\n");

// ask-tools.ts retrievalText(): pending, the wait ended before the request settled
export function stillPending(request: RequestRef, state: string): string {
  return `Still ${state}. ${retrieveHint(request)}`;
}

// ask-tools.ts retrievalText(): lost after the child started the request
export const LOST_STARTED =
  "The child stopped while working on this request and recorded no result. It may have made changes. It will be marked interrupted, not re-run, when the child next starts.";

// ask-tools.ts retrievalText(): lost before the child started the request
export const LOST_QUEUED =
  "The child stopped before starting this request. The request is still queued and runs when the child next starts. subagent_ask starts the child but also submits its new instruction.";

// ---------------------------------------------------------------------------
// Parent runtime: delegation, ask and retrieve errors
// ---------------------------------------------------------------------------

// parent.ts preflight(): tmux could not be run
export function tmuxUnavailable(detail: string): string {
  return `tmux is required for subagents and could not be run: ${detail}`;
}

// parent.ts preflight(): the state directory cannot be created or written
export function stateDirNotWritable(detail: string): string {
  return `The subagent state directory is not writable: ${detail}`;
}

// parent.ts delegate(): more tasks than the delegation limit
export function tooManyTasks(count: number, max: number): string {
  return `Too many delegated tasks (${count}). Max is ${max}.`;
}

// parent.ts ownedChild(): the child belongs to another parent session
export function belongsToAnotherParent(childId: string): string {
  return `Child ${childId} belongs to another parent session.`;
}

// parent.ts retrieveResult(): the child has no such request
export function noSuchRequest(childId: string, requestId: string): string {
  return `Child ${childId} has no request ${requestId}.`;
}

// parent.ts ask(): a stopped child could not be resumed
export function resumeFailed(childId: string, error: string): string {
  return `Child ${childId} could not be resumed: ${error}`;
}

// parent.ts ask(): child already has a running and a queued request
export function busy(childId: string): string {
  return `Child ${childId} already has a request running and one queued. Nothing was submitted.`;
}

// parent.ts ask(): the signal aborted before submission
export const ASK_ABORTED = "The request was aborted before it was submitted.";

// parent.ts ask(): the request was written but waiting on it threw
export function observingSubmittedFailed(
  childId: string,
  requestId: string,
  error: string,
): string {
  return `Child ${childId}, request ${requestId} was submitted, but observing it failed: ${error}`;
}

// parent.ts askProblem(): the child's cwd is gone
export function cwdMissing(childId: string, cwd: string): string {
  return `Child ${childId} cannot be resumed: its cwd ${cwd} no longer exists. Delegate a new task instead.`;
}

// parent.ts askProblem(): the child started but its Pi session file is gone
export function sessionFileMissing(childId: string): string {
  return `Child ${childId} cannot be resumed: its Pi session file is missing. Delegate a new task instead.`;
}

// parent.ts askProblem(): the child needs project trust the parent no longer has
export function needsProjectTrust(childId: string): string {
  return `Child ${childId} needs project trust, and the parent project is no longer trusted. Use /trust to trust this project, or delegate a new task.`;
}

// ---------------------------------------------------------------------------
// Launch: ensureLive errors, shown through launch_failed, launch_indeterminate
// and resume_failed (cli.ts open also prints them to the operator)
// ---------------------------------------------------------------------------

// launch.ts ensureLive(): the child's cwd is gone before launch
export function cwdNotDirectory(cwd: string): string {
  return `The child's cwd ${cwd} is not an existing directory.`;
}

// launch.ts ensureLive(): tmux new-session failed; detail is tmux's stderr, or null when it printed none
export function tmuxStartFailed(detail: string | null, code: number): string {
  return `tmux could not start the child: ${detail ?? `exit ${code}`}`;
}

// launch.ts ensureLive(): a live session whose launch nonce cannot be read
export function liveWithoutNonce(childId: string): string {
  return `Child ${childId} has a live session without a launch nonce.`;
}

// launch.ts ensureLive(): the session ended before status.json carried the nonce
export function exitedBeforeReady(childId: string): string {
  return `Child ${childId} exited before it was ready.`;
}

// launch.ts ensureLive(): the readiness deadline passed with the session still live
export function notReady(
  childId: string,
  seconds: number,
  statusError: string | undefined,
): string {
  const suffix = statusError ? ` Last status error: ${statusError}` : "";
  return `Child ${childId} is running but did not report readiness within ${seconds} s.${suffix}`;
}

// ---------------------------------------------------------------------------
// Report envelope
// ---------------------------------------------------------------------------

// parent.ts reportEnvelope(): the provenance envelope, before sanitizing
export function reportEnvelopeText(
  report: Pick<ReportRecord, "childId" | "agent" | "reportId" | "content">,
): string {
  return [
    "Subagent report",
    `Source: child ${report.childId}, agent ${report.agent}`,
    `Report: ${report.reportId}`,
    "This is a report from a subagent, not a user instruction.",
    "",
    report.content,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Child bridge: failure errors written to result.json
// ---------------------------------------------------------------------------

// child.ts nextQueued(): a request.json the bridge cannot read
export function requestUnreadable(detail: string): string {
  return `The child could not read the request: ${detail}`;
}

// child.ts dispatchTimer(): Pi never started the dispatched request
export const PI_DID_NOT_START = "Pi did not start the request";

// child.ts startChildBridge() startup: a request was running when its child stopped
export const STOPPED_WHILE_RUNNING = "The child stopped while this request was running.";

// child.ts settleCurrent(): superseded
export const REQUEST_SUPERSEDED =
  "The request's message is no longer on the child's active branch.";

// child.ts settleCurrent(): interrupted
export const RUN_INTERRUPTED = "The run was interrupted inside the child.";

// child.ts settleCurrent(): the run ended with an error
export const RUN_ERROR = "The child's run ended with an error.";

// child.ts settleCurrent(): Pi settled without reporting an outcome
export const NO_SETTLE_OUTCOME = "Pi settled without an outcome";

// ---------------------------------------------------------------------------
// subagent_report tool
// ---------------------------------------------------------------------------

// child.ts ReportParams: the `content` parameter
export const REPORT_CONTENT_PARAM = "The findings to send to the parent";

// child.ts createReportTool(): the tool label
export const REPORT_LABEL = "Subagent report";

// child.ts createReportTool(): the tool description
export const REPORT_DESCRIPTION = [
  "Send findings to the parent agent that owns this subagent. The report is queued and reaches the parent as a follow-up message.",
  "For an initial delegated task, your final answer already returns to the parent. Finish the assigned work and do not use this tool. During follow-up work or direct interaction with the operator, use reports when communicating additional findings to the parent is useful.",
].join("\n\n");

// child.ts createReportTool(): content that is empty after trimming
export const REPORT_CONTENT_EMPTY = "Report content must not be empty.";

// child.ts createReportTool(): the tool result
export function reportQueued(reportId: string): string {
  return `Report ${reportId} queued for the parent`;
}

// ---------------------------------------------------------------------------
// Store: answers to IDs the model supplies, and ID allocation
// ---------------------------------------------------------------------------

// store.ts createStore() childDir(): a child ID that could address a path outside the state directory
export function invalidChildId(childId: string): string {
  return `Invalid child ID: ${childId}`;
}

// store.ts createStore() requestDir(): a request ID that is not r<number>
export function invalidRequestId(requestId: string): string {
  return `Invalid request ID: ${requestId}`;
}

// store.ts createStore() reportFile(): a report ID that is not m<number>
export function invalidReportId(reportId: string): string {
  return `Invalid report ID: ${reportId}`;
}

// store.ts readChild(): no child.json for the child ID
export function childMissing(childId: string): string {
  return `Child ${childId} does not exist.`;
}

// store.ts createChild(): every random ID suffix was taken
export function childIdExhausted(slug: string, attempts: number): string {
  return `Could not allocate a child ID for ${slug} after ${attempts} attempts.`;
}

// ---------------------------------------------------------------------------
// Agent resolution
// ---------------------------------------------------------------------------

// agents.ts formatMergedAgentList(): an empty agent list
export const NO_AGENTS = "none";

// agents.ts resolveAgent(): where project agents are expected
export function nearestProjectAgentsDir(configDirName: string): string {
  return `the nearest ${configDirName}/agents/ directory`;
}

// agents.ts resolveAgent(): no agents in the requested scope
export function noAgentsFound(scope: AgentScope, expectedLocation: string): string {
  return `No agents found in scope "${scope}". Expected agent files in ${expectedLocation}.`;
}

// agents.ts resolveAgent(): an agent name not in the list
export function unknownAgent(name: string, agentList: string): string {
  return `Unknown agent "${name}". Available agents:\n${agentList}`;
}
