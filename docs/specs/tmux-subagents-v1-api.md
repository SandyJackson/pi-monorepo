# Tmux subagents V1: pass-one API contract

Status: agreed caller-facing design, consolidated from the operator interview; not implemented.
Scope: runtime operations, identities, retrieval results, tool schemas, timeouts, and persistence responsibilities.
Related: [V1 workflow and design](tmux-subagents-v1.md), [pass-two protocol contract](tmux-subagents-v1-protocol.md), [current implementation](../reference/subagents_structure.md), and [pi-intercom research](../research/pi-intercom.md).

This contract refines the V1 design. Where the earlier document leaves tool names, follow-up cardinality, submission semantics, or result retrieval open, this document takes precedence. It does not authorize source changes. The subsequent [pass-two protocol contract](tmux-subagents-v1-protocol.md) defines cross-process behavior and audits the supporting types.

## 1. Vocabulary

- A **child** is a persistent Pi conversation, not a process or tmux pane.
- A **request** is one instruction assigned to a child, initially or as a follow-up.
- A **result** is the child's recorded terminal completion or failure. A successful result contains an exact answer reference, not a copy of the answer text.
- A **retrieval outcome** describes one caller's attempt to obtain a result. Timeout or cancellation of retrieval does not change the request's result or stop its work.
- A **report** is a separate child-authored message queued to the owning parent. It neither completes a request nor replaces its result.

Use `result` for request completion records and `retrieveResult` for retrieval. Do not use `observe`, `waitFor`, or `retrieveResponse` as competing operation names. Preserve the existing term **delegated task outcome** for the initial delegation tool's ordered result contract; it is not another name for the persisted request result.

## 2. Identity and ownership

```ts
type ChildId = string;
type RequestId = string;
type ParentSessionId = string;
type ReportId = string;

interface RequestRef {
  readonly childId: ChildId;
  readonly requestId: RequestId;
}
```

These aliases express distinct domain identities. Their validation, generation, and any TypeScript branding belong to pass two; they are not interchangeable just because their representation is a string.

A child ID is stable across Pi process and tmux server restarts. A request ID identifies exactly one submitted instruction. Neither is a pane ID, process ID, turn counter, or array position.

The parent runtime is constructed for one explicit parent Pi session. Child metadata stores `parentSessionId`. Every parent work/retrieval operation validates the chain `request -> child -> parent`; it does not infer ownership from the current terminal or accept caller-supplied ownership as authority.

`RequestRef` does not duplicate parent identity or tmux location. Picker summaries and diagnostics may include both. A copied location is a snapshot, not an authoritative address after resume.

## 3. Parent-runtime operations

The agreed interface has five operations:

```ts
interface ParentRuntime {
  delegate(
    tasks: readonly ResolvedTask[],
    options: ObserveOptions,
  ): Promise<readonly TaskExecution[]>;

  ask(
    childId: ChildId,
    instruction: string,
    options: ObserveOptions,
  ): Promise<RequestExecution>;

  retrieveResult(
    request: RequestRef,
    options?: RetrieveOptions,
  ): Promise<RetrievalOutcome>;

  drain(reason: ParentDeparture): Promise<DrainResult>;

  dispose(): Promise<void>;
}
```

`ResolvedTask` and `TaskExecution` retain the current delegation contract's resolved agent settings, one-based task numbers, and ordered per-task outcomes. `ObserveOptions` is the working internal options name retained from the discussion, not a second retrieval operation. It supplies timeout, cancellation, and progress; delegation also accepts its purpose label through the options. Supporting type sketches and failure-category mappings are recorded in the [pass-two audit](tmux-subagents-v1-protocol.md#8-supporting-caller-contract-audit); implementation refinements are not permission to change the agreed semantics.

### `delegate`

Create children, submit their initial requests, and retrieve their results. Preserve the existing maximum of eight tasks, strict validation, valid-sibling execution, sequential launches with concurrent observation, ordered outcomes, trust gating, agent settings, and answer truncation behavior.

Once launch processing starts, return exactly one positional delegated task outcome per accepted task. Shared pre-launch failures retain the existing tool-error behavior. Do not rewrite the existing outcome vocabulary merely to expose the internal protocol.

Expose `childId` when a child exists and `requestId` when a request has been assigned, including uncertain submission and post-submission timeout/cancellation. A reference identifies an attempt; its presence alone does not prove durable submission.

### `ask`

Address one existing child. Validate ownership and current permission constraints, resume its saved conversation if stopped, submit one follow-up, then use the same retrieval implementation as `retrieveResult`.

If the child is active, permit one pending parent follow-up behind its current work. Further submissions return `busy` without publishing another request. Never steer active work. Queue arbitration, drain interaction, and safe resume are pass-two protocol responsibilities.

### `retrieveResult`

Retrieve the result of the specified request:

- Return its recorded terminal result immediately when available.
- Otherwise wait for that same request, subject to this call's timeout and cancellation.
- Never publish another instruction, replay the instruction, or start/resume Pi.
- Never equate startup idle or the latest unrelated assistant entry with completion.
- If state cannot establish a result or ongoing execution, report unavailability honestly.

This is also the recovery operation after an earlier wait timed out or was cancelled. It must not require the original in-memory runtime object or tool invocation to still exist.

### `drain`

Persist close-when-idle intent for this parent's children and return promptly, without waiting for their work to complete. Busy children finish already-submitted work; blocked children remain available. Follow the V1 lifecycle rules on clean quit and conversation replacement. Reload never drains.

`DrainResult` must distinguish successfully recorded intent from bookkeeping failures. Shutdown cleanup is bounded and non-throwing for expected operational failures; failure to record an intent must not be reported as successful draining. Exact structure is deferred to pass two.

### `dispose`

Remove this runtime's local timers and observers. Do not submit work, drain, interrupt, or stop children. This makes disposal safe during reload.

Pi lifecycle hooks explicitly invoke the appropriate operations. Constructing the runtime must not secretly register shutdown handlers. Child reporting, metadata queries, and inspection are separate interfaces, not additional work methods on `ParentRuntime`.

## 4. Submission contract

Both `delegate` and `ask` share submission and retrieval internals. They must not independently implement cancellation, correlation, or waiting behavior.

```ts
type SubmissionResult =
  | { status: "submitted"; request: RequestRef }
  | {
      status: "not_submitted";
      reason: "aborted" | "invalid_target" | "storage_failed";
    }
  | {
      status: "submission_indeterminate";
      request: RequestRef;
      error: string;
    };
```

- `submitted` guarantees durable publication. It does not guarantee child acceptance, execution start, or completion.
- `not_submitted` guarantees this attempt cannot cause that instruction to execute later. It does not assert that a child process could never have been created during preparation.
- `submission_indeterminate` means publication may have succeeded. Preserve the request reference and reconcile it; do not blindly submit another instruction with a new ID.

Durable publication is the cancellation boundary. Before publication, cancellation can prevent submission. After publication, cancellation stops retrieval only: even a queued instruction may subsequently execute.

A cancellation racing publication cannot be reported as definitely unsubmitted without evidence. Uncertain storage failure is not `storage_failed` with an implied safe retry.

The shown union defines publication results. `busy`, confirmed launch/resume failure, invalid agent input, and other preparation failures remain distinct operational outcomes; they are not forced into a storage-error code. `RequestExecution` must preserve the appropriate submission or preparation outcome, or the subsequent retrieval outcome, without discarding request identity. Its enclosing union and required mappings are recorded in the [pass-two audit](tmux-subagents-v1-protocol.md#8-supporting-caller-contract-audit).

## 5. Request results and retrieval outcomes

```ts
interface SessionAnswerRef {
  readonly path: string;
  readonly entryId: string;
}

type RequestState = "submitted" | "queued" | "running" | "blocked";

type RequestResult =
  | {
      status: "completed";
      answer: SessionAnswerRef | null;
      humanIntervened: boolean;
    }
  | {
      status: "failed";
      reason:
        | "execution_failed"
        | "answer_superseded"
        | "session_closed";
      error: string;
    };

type RetrievalOutcome =
  | {
      status: "retrieved";
      request: RequestRef;
      result: RequestResult;
    }
  | {
      status: "timed_out" | "aborted";
      request: RequestRef;
      lastKnownState: RequestState;
    }
  | {
      status: "unavailable";
      request: RequestRef;
      reason:
        | "request_not_found"
        | "state_unreadable"
        | "process_lost";
      error: string;
    };
```

These are the agreed caller-facing distinctions. A last-known state is an observation, not proof that the child remains in that state. Do not invent a running/queued state if none can be established; return the appropriate unavailable outcome instead. Terminal results found during retrieval take precedence over progress snapshots.

`completed` may contain `answer: null` when no final answer was persisted. `answer_superseded` means the request can no longer be correlated on the child's active branch; it must not return an abandoned branch's answer. `humanIntervened` flags relevant direct interactive input without introducing automatic reports of every human action.

`process_lost` means there is no recorded result and no confirmed ongoing execution. It is an observation failure, not a child-authored request failure, and does not establish that a retry is safe. `unavailable` does not promise automatic recovery or resubmission.

The child selects the exact answer entry for the request; presentation resolves that reference to text. Subsequent turns must not change the answer returned for an already-recorded result. Correlation, interruption/error classification, and recording a final failure when the child cannot write one require pass-two decisions; they must not be guessed from idle state.

## 6. Timeouts and cancellation

Runtime durations are milliseconds. Model-facing tool `timeout` values remain positive integer minutes, preserving the current tool convention; convert once in the tool adapter.

Defaults follow explicit override, then the child's captured agent timeout, then 60 minutes.

- Initial delegation retains its per-task budget from confirmed launch. Later siblings launching does not delay the start of an earlier child's observation.
- For `ask`, the retrieval budget begins at durable submission and includes time spent queued behind active work.
- Every explicit `retrieveResult` call receives a fresh waiting budget. It does not reuse the original request's expired deadline.
- Recorded results return immediately, without starting a process or another work turn.
- Timeout and cancellation end retrieval, not the request. Do not write a cancelled/failed terminal request result merely because the parent stopped waiting.

Startup/resume needs a separate bounded internal handshake. Its exact limit and arbitration are pass-two work. A follow-up's retrieval budget must not be misrepresented as covering preparation before durable submission.

## 7. Model-facing tools

All tool parameter schemas are strict: reject unknown properties. Validate non-empty instructions, report content, and identities. Preserve existing initial delegation validation and presentation behavior.

### `subagent`

```ts
{
  tasks?: Array<{ agent: string; instruction: string; cwd?: string }>;
  label?: string;
  timeout?: number;
}
```

Omitted/empty tasks list the catalog. At most eight tasks. `label` describes the delegation's purpose, not a physical tmux tab. Return ordered per-task outcomes and the available child/request references.

### `subagent_ask`

```ts
{
  childId: string;
  instruction: string;
  timeout?: number;
}
```

One child per call, not a batch. Submit and retrieve through `ask`. Return a preparation/submission failure, uncertain submission, or retrieval outcome. A submitted request's reference remains available after timeout or cancellation. `busy` means this call did not enqueue another request.

### `subagent_retrieve`

```ts
{
  childId: string;
  requestId: string;
  timeout?: number;
}
```

Call `retrieveResult` for existing work. No new task, process launch, or resume. Return `RetrievalOutcome`, with answer text resolved/truncated for model presentation while structured details retain references rather than duplicated answer text.

### `subagent_report`

```ts
{
  content: string;
}
```

Available to delegated children only. The bridge determines the owning parent, child identity, and report ID. The model cannot choose an arbitrary recipient or assert a different identity. Success returns `reportId` and means durably queued, not delivered, read, or acted upon.

Use guidance, not a deterministic restriction, to discourage early or duplicate initial-task reporting:

> For an initial delegated task, finish the assigned work before sending a report. Your normal final answer already returns through delegation; do not duplicate it with this tool. During follow-up work or direct interaction with the operator, use reports when communicating additional findings to the parent is useful.

A report remains callable during work. It does not complete the request, satisfy a UI question, or replace the final result. Deliver through a generated provenance envelope as a parent follow-up, never steering. Retain reports while the owning parent is closed. Delivery acknowledgment mechanics are pass-two work.

`drain` and `dispose` are not model tools. Metadata listing and float attachment remain CLI/UI operations.

## 8. Durable placement and lookup

Use one metadata file per child alongside its Pi session data. The agreed initial layout is:

```text
~/.pi/agent/subagents/<childId>/
  metadata.json
  session/
    ...Pi session files...
  requests/<requestId>/
    request.json
    result.json
```

- `metadata.json` holds stable child identity, parent ownership, owning worktree, execution cwd, captured agent configuration, and Pi session/resume information.
- `request.json` is parent-written and immutable after publication. It contains the request reference and instruction. It exists before the child is expected to acknowledge work.
- `result.json` is child-bridge-written progress followed by the terminal result and exact answer reference. Progress is not a `RequestResult`; the persisted record's versioned union is pass-two work.

Publish complete JSON atomically; readers must not observe half-written records. Separate parent and child files prevent mutual overwrites. Do not introduce a shared parent JSONL journal or a generic registry framework merely to enumerate children.

The directory survives Pi process exit, private tmux server shutdown, and worktree removal. Missing transcript/cwd must produce an actionable error rather than silently creating a new conversation.

Live tmux state is discovered and validated when needed, not unnecessarily mirrored in a separate comprehensive runtime-state database. Derive a deterministic session name from child identity. Socket selection, incarnation validation, startup handshake, and exclusive launch/resume remain pass-two details. A pane ID alone is never sufficient identity.

A read-only child lookup returns a combined metadata/live-state snapshot; it does not submit work or resume Pi. Parent and picker must share lookup/resume logic rather than independently guessing locations. Exact query/inspection signatures are reserved for pass two.

## 9. Acceptance examples

1. `ask` submits request B behind running request A. Cancelling B's retrieval leaves B queued. Another ask returns `busy` until the pending slot is free.
2. B completes after its original retrieval times out. `retrieveResult(B)` returns its recorded result immediately, including the original exact answer reference.
3. B remains ongoing. A later retrieval gets a fresh budget, with no repeated instruction or process launch.
4. The parent aborts before publication. The operation returns `not_submitted`; no later child startup can discover and execute that instruction.
5. Publication fails ambiguously. The operation returns the same request reference with `submission_indeterminate`, not an invitation to resubmit under a new ID.
6. A child is stopped with a completed result. Retrieval still works from disk. `ask` instead resumes its saved Pi conversation and submits a new request.
7. A child sends a report while working. It is queued separately; the current request does not become completed, and the parent is never steered.
8. Extension reload disposes local observers but does not drain children. A clean departure records draining without waiting for child completion.

## 10. Pass-two coverage

Do not infer implementation guarantees from method names or the filesystem sketch. The [pass-two protocol contract](tmux-subagents-v1-protocol.md) addresses the following areas raised by this pass:

- Request/result/report record schemas, versions, exact writer ownership, and acknowledgment meanings.
- Atomic publication versus storage durability, ID/content consistency, uncertain delivery, deduplication, and retry/reconciliation behavior.
- Concurrent queue admission, exclusive launch/resume claims, incarnation checks, drain intent ownership, and stale-intent supersession.
- Branch-aware request/input/answer correlation and direct-human-input provenance under aborts, errors, branching, and compaction.
- How child-authored completion and parent-observed process loss interact without multiple writers corrupting a result record.
- Final `RequestExecution`, preparation errors, `DrainResult`, options/progress types, and mapping to existing delegated task outcomes.
- Report acknowledgment, persistence confirmation, parent wake behavior, and ambiguous delivery recovery.
- The inspection command's list/open/dismiss interface and shared lookup behavior.

The two passes fix caller behavior and high-level protocol guarantees, not every helper or error-code spelling. Supporting implementation types may be refined without silently changing those guarantees. Source implementation and real Pi/tmux integration remain future work.
