# Tmux subagents V1: pass-two protocol contract

Status: high-level protocol design consolidated from the operator interview; not implemented.
Read with: [V1 design](tmux-subagents-v1.md) and [pass-one API contract](tmux-subagents-v1-api.md).

This document completes the agreed cross-process behavior without prescribing a lock library, polling interval, or floating-pane geometry. Supporting type sketches below make the caller contract consistent; they are not a new general messaging interface. Implementation still requires a separate request and the integration checks in the V1 design.

## 1. Ownership and records

Retain the child directory agreed in pass one, with a separate report path:

```text
~/.pi/agent/subagents/<childId>/
  metadata.json
  session/
  requests/<requestId>/
    request.json
    result.json
  reports/<reportId>/
    report.json
    delivery.json
```

The report directory nesting is a proposed concrete encoding of the agreed ownership, not an external compatibility promise.

- The parent publishes `request.json` once. Its instruction and request identity never change.
- The child bridge writes `result.json`: first progress, then a terminal result. Settled results are immutable.
- The child publishes `report.json` once. Its report ID, source, recipient ownership, and content never change.
- The owning parent writes `delivery.json`. A child cannot mark its own report delivered.
- Metadata and minimal launch/drain coordination state are updated only under child-scoped coordination. Do not create a comprehensive duplicate database of live tmux state.

Publish complete records atomically. Readers must not see partial JSON. A durable-submission success requires the publication durability policy to have completed, not merely an in-memory write or temporary file. If publication may have become visible despite a later failure, return uncertainty rather than definitely unsubmitted.

Every record carries a format version and its relevant stable identity. Validate records before acting on them. Reject conflicting reuse of a request/report ID with different content; do not silently overwrite or execute the replacement. Identity in a model-authored body is not authority.

The child ID names the conversation. A new incarnation ID names each Pi process launch/resume. Child progress and startup acknowledgment identify their incarnation, preventing an old process's state from proving that a new process started. Exact token generation and minimal coordination-state encoding are implementation details.

## 2. Coordination

Use one short-lived coordination lock per child for queue admission, acceptance transitions, launch/resume decisions, and drain-intent changes. Use concrete functions, not a general lock-manager framework.

Never hold this lock while waiting for model work, retrieving a result, or awaiting child startup acknowledgment. Brief contention receives bounded retries; exhaustion is a coordination error, not `busy`. The latter specifically means the pending-follow-up slot is occupied.

A lock's age alone never permits stealing it. Reclaim only when its recorded owner is demonstrably gone, with ownership-safe recovery and release. If ownership cannot be established safely, fail closed with an actionable error. A PID probe alone is not exclusive arbitration.

### Queue admission

Under the lock, validate ownership and drain state, check capacity, then publish the request. The child bridge uses the same coordination when accepting pending work.

There is at most one executing/accepted parent request plus one pending parent follow-up. Direct human work may also occupy Pi; it does not create another parent-request execution slot. Further asks return `busy` without publishing. A cancelled retrieval leaves any durably submitted instruction in this queue.

Do not steer a busy child. Accept the next pending request only when ready to dispatch it; do not prefill Pi's volatile queue with multiple parent requests. Admission and acceptance must agree on when the pending slot becomes free.

### Launch/resume

Under coordination, discover the deterministic tmux session and validate child/incarnation identity:

- Reuse a matching live child.
- Join an already-reserved startup attempt rather than launching again.
- For a confirmed stopped child, reserve a new incarnation and launch its saved Pi conversation.
- Return uncertainty when identity or liveness cannot safely be established.

The startup reservation survives release of the short lock. Wait for a matching startup acknowledgment outside the lock, under a bounded startup budget. Missing acknowledgment is not proof that launch failed. Reconcile before any retry, and never permit two Pi writers for the same conversation.

The budget must be finite and tested; its numerical value is an internal implementation choice, not a new model-facing setting. Startup timeout alone must not delete a reservation belonging to a possibly live child.

## 3. Request execution

The minimal record shape is an identity/version envelope plus progress or a terminal result:

```ts
type RequestRecordState =
  | {
      version: 1;
      request: RequestRef;
      incarnationId: string;
      phase: "accepted" | "running";
    }
  | {
      version: 1;
      request: RequestRef;
      incarnationId: string;
      phase: "settled";
      result: RequestResult;
    };
```

Blocked attention may be carried as additional live progress; it does not settle the request. Presence of `request.json` without `result.json` means no child acknowledgment has been recorded. It does not prove non-delivery.

The bridge:

1. Accepts pending work when ready to dispatch and records its request/incarnation identity.
2. Persists a request correlation marker in the Pi conversation before injecting the instruction.
3. Records actual request start separately from acceptance. Neither a marker nor acceptance proves execution began.
4. At settlement, selects the exact final assistant entry associated with that request on the active branch and publishes its terminal result atomically.
5. Never rewrites a settled result because later turns or branches change the conversation.

Use request identity, not instruction-text matching or settled-turn counters. The correlation marker lives in the existing Pi history; do not add a parallel event journal solely to track it. Recording acceptance and injecting into Pi are not a single atomic operation. Keep that failure window explicit.

Direct human input remains allowed. Record `humanIntervened` when it affects outstanding work. If a branch change before settlement removes the request's correlation, record `answer_superseded`, not another branch's answer. An explicitly observed execution failure produces a failed result; lack of an answer alone is not sufficient evidence of such failure.

## 4. Recovery and result retrieval

`retrieveResult` reads persisted results first, then observes the same request if ongoing. It never resubmits or launches/resumes Pi. Completed results remain retrievable after process/server exit.

If a child disappears without writing a terminal result, the parent reports unavailability such as `process_lost`. It must not impersonate the child by writing a fabricated failure into the child-owned result file.

Recovery may reconcile request markers and persisted Pi history. If they cannot establish whether accepted work executed, expose uncertainty for inspection or explicit recovery. Never automatically replay the instruction. This policy applies even when no result was recorded, since side effects may already have happened.

A process incarnation mismatch is a reason to reconcile, not permission to discard existing results or replay accepted work. Resume alone does not transform uncertain earlier work into a new request.

## 5. Reports and delivery acknowledgment

Reports are immutable messages owned by the child. Generate source/parent/report identity outside model-supplied content and retain the pass-one provenance envelope stating that this is a subagent report, not user instructions.

The reporting tool succeeds only after durable publication. Success means queued, not delivered or read. Reports do not complete requests or replace normal delegation results.

The parent delivers only when the owning Pi conversation is active:

- While busy, queue as a follow-up; never steer.
- While idle, start a follow-up turn to process it.
- While closed or another conversation is active, retain it on disk. Do not relaunch the parent to deliver it.

Serialize delivery attempts for the same report. Record the report ID in persisted parent history as part of the generated message/metadata. A send call returning or a message entering Pi's in-memory queue does not prove persisted delivery or model consumption.

Parent-owned delivery state distinguishes pending/attempted delivery, confirmed persistence, and uncertainty. Acknowledgment means that the report is in persisted parent history; it does not mean the model processed or acted on it.

On missing confirmation:

1. Search the owning parent's persisted history for the report ID.
2. If found, confirm delivery without injecting again.
3. If still uncertain, resend using the same ID with an explicit possible-duplicate label.

This deliberately favors retaining information over silently losing reports. It does not promise exactly-once model execution. A fresh report ID is not a safe retry of an uncertain report.

## 6. Drain, parent resume, and inspection

Drain means finish all already-submitted work, including the pending follow-up, then exit when idle. A draining child rejects new asks; admission and drain changes share coordination so new work cannot slip in after the decision.

Clean parent departure or conversation replacement records drain intent and returns promptly. Reload only disposes/restores local observers. Blocked children remain available and retain attention state; after unblocking and finishing they honor drain intent.

Resuming the owning parent clears its stale drain intent under coordination. Parent identity does not change merely because its Pi process restarted. A resumed parent and an exiting child must reconcile under the same rules as launch/resume, not assume the other process will remain live.

Explicit inspection of a drained child temporarily keeps Pi available while at least one viewer is attached. Inspection does not permanently clear drain intent. After the last viewer dismisses, finish submitted work and exit when idle. A blocked child still remains available. Explicit Pi quit inside inspection remains an explicit process exit.

Coordinate opening a viewer with shutdown so the child cannot immediately honor stale close intent before attachment. The minimal reservation/attachment check is private implementation detail; it must not require a permanent supervisor.

## 7. Inspection command interface

Provide three capabilities through a small CLI/UI module. Exact command spelling is not a compatibility promise yet:

- **List** accepts an explicit worktree or resolves it from the invoking tmux pane. Return children grouped by parent, including saved stopped children, without starting Pi.
- **Open** accepts a child ID and outer tmux placement context. Validate it, resume if needed through shared launch logic, then attach a viewer in a floating pane.
- **Dismiss** addresses the viewer and its outer socket. Disconnect only that viewer; do not kill the private child session.

Parent and picker share lookup and launch/resume code. Missing/ambiguous worktree scope is an explicit error, never a fallback to unrelated children. Saved metadata is authoritative for ownership; live tmux identity must be validated before attachment.

Close the picker before opening a modal inspector. Keep Escape/Ctrl-C available to Pi and supply an outer tmux dismissal action. If the child exits during attachment, terminate the viewer with a clear message; do not restart it in a loop. These are tmux floating panes, not popups.

## 8. Supporting caller-contract audit

The following names fill gaps in pass one without introducing a generic transport interface:

```ts
interface RetrieveOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (update: { request: RequestRef; state: RequestState }) => void;
}

type ObserveOptions = RetrieveOptions & { label?: string };
type ParentDeparture = "quit" | "new" | "resume" | "fork";

type RequestPreparationFailure = {
  status: "rejected";
  childId: ChildId;
  reason:
    | "busy"
    | "draining"
    | "invalid_target"
    | "coordination_failed"
    | "resume_failed";
  error: string;
};

type RequestExecution =
  | RequestPreparationFailure
  | Exclude<SubmissionResult, { status: "submitted" }>
  | { status: "submitted"; request: RequestRef; retrieval: RetrievalOutcome };

interface DrainResult {
  children: Array<
    | { childId: ChildId; status: "recorded" }
    | { childId: ChildId; status: "failed"; error: string }
  >;
  error?: string; // Parent-level enumeration/storage failure, not false empty success.
}
```

These declarations are contract sketches, not standalone implementation code; they use pass-one types and preserve its milliseconds/minutes distinction. Refine exact error codes during implementation without collapsing the failure categories or implying safe retries. Internal `ObserveOptions` is an options alias only; the operation remains `retrieveResult`. Initial delegation retains the existing per-task timeout resolution and ordered contract, not a single shared batch execution deadline.

Preserve these mappings:

- Preparation/publication rejection creates no new executable instruction.
- Uncertain publication keeps a request reference and is not a confirmed storage/launch failure.
- Retrieved completion resolves its exact answer for presentation.
- Retrieved execution failure remains distinguishable from inability to observe.
- Timeout/abort returns the submitted request reference and leaves work intact.
- Lost process or unreadable state yields an unavailable retrieval outcome, not a parent-written terminal result.
- Initial launch failures and ambiguity preserve their existing ordered outcome distinction.
- `answer_superseded` is a real request result, but its initial-tool mapping must remain explicit rather than reporting successful completion. Extend the existing typed outcome if necessary; do not silently discard this information.

## 9. Verification and implementation latitude

Before implementation is called ready, test concurrent queue admissions, competing resumes, child startup without acknowledgment, acceptance-before-injection failure, immutable settled results, human/branch interference, persisted report confirmation, duplicate-marked report recovery, drain with queued work, parent resume against child exit, and multiple viewer dismissal.

Use the V1 design's real Pi/tmux/Workmux integration gates. File protocol tests do not prove terminal rendering, Pi input correlation, or persistence-event timing.

Implementation may choose concrete lock primitives, record validators, polling intervals, the finite startup budget, and CLI/UI geometry. It may not silently weaken durable submission, ownership, single-writer execution, cancellation semantics, or uncertainty reporting. If a promised invariant is infeasible with the pinned Pi version, return to the design rather than masking it with optimistic state.

No additional broker, event-sourcing framework, heartbeat supervisor, or general scheduler is required by this protocol. Source changes remain unrequested.
