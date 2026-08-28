# Proposed Herdr Subagent Architecture

> **Status: proposed.** This document describes the agreed post-refactor design. It is not a description of the current implementation. See [`subagents_structure.md`](./subagents_structure.md) for the current architecture and [`../../PLAN.md`](../../PLAN.md) for the implementation plan.

## Purpose

The refactor makes subagent delegation easier to understand and modify by removing speculative runtime abstraction, duplicate single/parallel orchestration, wave scheduling, correlation IDs, and leaked cleanup details.

The design uses fewer, deeper modules:

- the tool module owns Pi-facing policy and presentation;
- one concrete Herdr delegation module owns execution;
- one Herdr session module owns a visible child session's lifecycle;
- the only runtime port is the real JSON-RPC process seam.

## Domain model

| Term | Meaning |
|---|---|
| **Subagent delegation** | One parent tool call containing one or more delegated tasks. |
| **Delegated task** | One turn assigned to a visible subagent. |
| **Delegated task number** | The one-based, delegation-scoped identity assigned once to a requested task. |
| **Visible subagent session** | The persistent child Pi session in a Herdr pane. It may outlive the delegated task. |
| **Delegated task outcome** | The single terminal result associated with a delegated task. |
| **Callable agent catalog** | The session-scoped snapshot of user/workspace agents and trusted project overrides. |

A delegated task and a visible subagent session are deliberately different lifetimes:

```mermaid
flowchart LR
    D[Subagent delegation] --> T1[Task 1: one turn]
    D --> T2[Task 2: one turn]
    T1 --> S1[Visible session A]
    T2 --> S2[Visible session B]
    S1 -. may receive later turns .-> F1[Future interaction]
    S2 -. remains available after outcome .-> F2[Manual takeover]
```

## Proposed package structure

```text
packages/herdr-subagent/
├── index.ts                 # Pi lifecycle adapter and composition root
├── subagent-tool.ts         # Request policy, task resolution, presentation
├── agents.ts                # Session-scoped callable agent catalog
├── pi-session.ts            # Session metadata and exact answer-entry access
└── herdr/
    ├── delegation.ts        # Workspace placement and ordered execution
    ├── session.ts           # Child launch, observation, prompt ownership
    └── rpc.ts               # Unix-socket NDJSON transport
```

The `herdr/` directory groups one concrete runtime implementation. It is not a generic backend layer.

## Module dependency diagram

```mermaid
flowchart TB
    Pi[Pi Extension Host]
    Index[index.ts\ncomposition root]
    Tool[subagent-tool.ts\npolicy and presentation]
    Agents[agents.ts\ncallable agent catalog]
    Delegation[herdr/delegation.ts\ndeep execution module]
    Session[herdr/session.ts\nvisible session lifecycle]
    Rpc[herdr/rpc.ts\nJSON-RPC transport]
    PiSession[pi-session.ts\nJSONL session access]
    Herdr[(Herdr Unix socket)]
    Files[(Agent files and Pi session JSONL)]

    Pi --> Index
    Index --> Agents
    Index --> Tool
    Tool --> Delegation
    Tool --> PiSession
    Delegation --> Session
    Delegation --> Rpc
    Session --> Rpc
    Session --> PiSession
    Rpc --> Herdr
    Agents --> Files
    PiSession --> Files

    style Tool fill:#6d5dfc,color:#fff
    style Delegation fill:#e85d75,color:#fff
    style Session fill:#e99b3e,color:#111
    style Rpc fill:#3f8cff,color:#fff
```

### Dependency rule

`subagent-tool.ts` imports only the deep `executeHerdrDelegation` operation from the Herdr implementation. It does not know about panes, RPC methods, launch retries, prompt files, polling, or workspace locking.

No `SubagentBackend`, `BackendSelection`, `SpawnBatchResult`, or backend auto-detection interface remains.

## Module responsibilities

| Module | Owns | Does not own |
|---|---|---|
| `index.ts` | Pi lifecycle, project trust, session catalog snapshot, tool registration, dependency composition | Validation, execution, Herdr protocol |
| `subagent-tool.ts` | Strict tool schema, semantic task validation, agent resolution, task numbering, mixed valid/invalid merging, progress semantics, final content/details | Herdr RPC, pane placement, prompt files, polling |
| `agents.ts` | Agent file discovery, frontmatter parsing, nearest project catalog, precedence, sorted immutable catalog | Per-task rediscovery, Herdr execution |
| `pi-session.ts` | Pi header parsing, exact terminal assistant entry selection, answer-entry resolution | Polling Herdr, rendering tool output |
| `herdr/delegation.ts` | Herdr environment validation, workspace tab lock/provisioning, pane placement, sequential launch, ordered outcome accounting | Model-facing formatting, agent discovery |
| `herdr/session.ts` | One child launch, argv, labels, retries, launch certainty, prompt lease, Pi-hook-backed turn observation, session metadata capture | Multi-task ordering, tool presentation |
| `herdr/rpc.ts` | Request IDs, NDJSON framing, socket lifecycle, timeout, abort, JSON-RPC response errors | Domain classification, retries, pane policy |

## Main interfaces

The types below are illustrative. Exact TypeScript placement may change while preserving these contracts.

```mermaid
classDiagram
    direction TB

    class SubagentTool {
        +execute(params, signal, onUpdate) ToolResult
    }

    class CallableAgentCatalog {
        <<ReadonlyMap>>
        +get(agentName) AgentConfig
        +values() AgentConfig[]
    }

    class DelegatedTask {
        +taskNumber: number
        +agent: string
        +instruction: string
        +cwd: string
        +config: AgentConfig
    }

    class DelegatedTaskExecution {
        +task: DelegatedTask
        +outcome: DelegatedTaskOutcome
    }

    class HerdrDelegation {
        +execute(tasks, options) DelegatedTaskExecution[]
    }

    class HerdrSession {
        +session: SessionRef
        +observeTurn(options) DelegatedTaskOutcome
    }

    class HerdrRpc {
        <<interface>>
        +request(method, params, options) TResult
    }

    class UnixSocketHerdrRpc {
        +request(method, params, options) TResult
    }

    class PiSessionAccess {
        +inspect(path) PiSessionSnapshot
        +readAnswer(ref) string|null
    }

    SubagentTool --> CallableAgentCatalog
    SubagentTool --> HerdrDelegation
    SubagentTool --> PiSessionAccess
    HerdrDelegation --> DelegatedTask
    HerdrDelegation --> DelegatedTaskExecution
    HerdrDelegation --> HerdrSession
    HerdrSession --> HerdrRpc
    HerdrSession --> PiSessionAccess
    UnixSocketHerdrRpc ..|> HerdrRpc
```

`HerdrRpc` is an earned port: production uses a Unix-socket adapter and tests use a scripted adapter. There is no runtime-neutral subagent port above it.

## Session-scoped catalog lifecycle

Agent discovery happens once per Pi session lifecycle, not once per task or tool call.

```mermaid
sequenceDiagram
    participant Pi
    participant Index as index.ts
    participant Agents as agents.ts
    participant Tool as subagent-tool.ts

    Pi->>Index: session_start(ctx)
    Index->>Agents: discoverCatalog(ctx.cwd, trusted)
    Agents->>Agents: load global agent files
    opt trusted project
        Agents->>Agents: load nearest project agent directory
        Agents->>Agents: project definitions override matching global names
    end
    Agents-->>Index: immutable callable catalog
    Index->>Tool: createSubagentTool(catalog, executeHerdrDelegation)
    Index->>Pi: registerTool(description from same catalog)

    Note over Index,Tool: /reload, /new, /resume, and /fork produce a new session snapshot
```

This guarantees that the tool description and runtime resolution agree. Agent file changes become visible through Pi's normal session/reload lifecycle.

## Tool execution flow

### Request validation and partial acceptance

Structurally malformed calls are rejected by the strict TypeBox schema. Well-shaped task entries are validated independently.

```mermaid
flowchart TD
    Start([Tool call]) --> Envelope{Strict request shape?}
    Envelope -->|No| SchemaError[Pi schema error]
    Envelope -->|Yes| Limit{At most 8 tasks?}
    Limit -->|No| LimitError[Reject request]
    Limit -->|Yes| Number[Assign Task 1..N exactly once]
    Number --> Resolve[Resolve each task from session catalog]
    Resolve --> Partition{Task valid?}
    Partition -->|No| Invalid[Store positional invalid outcome]
    Partition -->|Yes| Valid[Keep original numbered task record]
    Invalid --> More{More tasks?}
    Valid --> More
    More -->|Yes| Resolve
    More -->|No| AnyValid{Any valid tasks?}
    AnyValid -->|No| Present[Present ordered outcomes; never initialize Herdr]
    AnyValid -->|Yes| Execute[Execute valid tasks in Herdr]
    Execute --> Merge[Merge outcomes by original task number]
    Merge --> Present
```

Invalid siblings do not block valid tasks. The one-based `taskNumber` is the only task correlation identity throughout the pipeline.

## Herdr delegation execution

### Sequential launch with immediate concurrent observation

There is no four-task wave scheduler. Up to eight valid tasks are launched sequentially. Observation starts immediately after each confirmed launch and overlaps later launches.

```mermaid
sequenceDiagram
    participant Tool as subagent-tool.ts
    participant Delegation as herdr/delegation.ts
    participant Session as herdr/session.ts
    participant Herdr

    Tool->>Delegation: execute(tasks ordered by taskNumber)
    Delegation->>Herdr: find or create shared subagents tab
    alt environment or workspace unavailable
        Herdr-->>Delegation: setup failure before launch
        Delegation-->>Tool: throw Error
    else workspace ready
        loop each valid task in request order
            Delegation->>Session: launch(task, targetPane)
            Session->>Herdr: agent.start
            alt launch confirmed
                Herdr-->>Session: paneId
                Session-->>Delegation: visible session
                Delegation->>Session: observeTurn() without awaiting
                Note over Session,Herdr: Observation runs while later tasks launch
            else launch explicitly failed
                Session-->>Delegation: launch_failed outcome
            else response ambiguous
                Session-->>Delegation: launch_indeterminate outcome
            end
        end
        Delegation->>Delegation: await all observation promises
        Delegation-->>Tool: ordered task executions
    end
```

The process-wide workspace lock covers shared tab provisioning and sequential pane placement. It does not wait for child turns to settle.

### Positional accounting

```mermaid
flowchart LR
    subgraph Request
        R1[Task 1]
        R2[Task 2 invalid]
        R3[Task 3]
        R4[Task 4]
    end

    subgraph HerdrInput[Valid Herdr input]
        H1[Task 1 record]
        H3[Task 3 record]
        H4[Task 4 record]
    end

    subgraph Final[Final details.tasks]
        O1[Task 1 completed]
        O2[Task 2 invalid]
        O3[Task 3 timed_out]
        O4[Task 4 launch_failed]
    end

    R1 --> H1 --> O1
    R2 ----------------> O2
    R3 --> H3 --> O3
    R4 --> H4 --> O4
```

No invocation ID, duplicate numbering, backend correlation map, or runtime output parser is needed.

## Visible session lifecycle

```mermaid
stateDiagram-v2
    [*] --> Preparing
    Preparing --> AbortedBeforeLaunch: signal aborted
    Preparing --> LaunchFailed: preparation or confirmed RPC failure
    Preparing --> Starting: call agent.start
    Starting --> LaunchIndeterminate: response lost or incomplete
    Starting --> Observing: pane confirmed

    Observing --> Observing: working or blocked
    Observing --> Settling: idle after activity
    Settling --> Observing: active or unknown again
    Settling --> Completed: stable settled observations
    Observing --> TimedOut: per-task deadline
    Settling --> TimedOut: per-task deadline
    Observing --> AbortedObserving: signal aborted
    Settling --> AbortedObserving: signal aborted
    Observing --> SessionClosed: pane disappears
    Settling --> SessionClosed: pane disappears
    Observing --> ObservationFailed: non-recoverable observation error
    Settling --> ObservationFailed: non-recoverable observation error

    Completed --> [*]
    TimedOut --> [*]
    AbortedBeforeLaunch --> [*]
    AbortedObserving --> [*]
    LaunchFailed --> [*]
    LaunchIndeterminate --> [*]
    SessionClosed --> [*]
    ObservationFailed --> [*]
```

`Completed`, `TimedOut`, and `AbortedObserving` end the parent's observation of a delegated turn. They do not terminate the visible subagent session.

## Pi-hook-backed settlement observation

The parent does not infer completion from process exit. Herdr's managed Pi extension projects child Pi lifecycle hooks into Herdr state.

```mermaid
sequenceDiagram
    participant Child as Child Pi
    participant Hook as Herdr-managed Pi extension
    participant Herdr
    participant Observer as herdr/session.ts

    Child->>Hook: agent_start
    Hook->>Herdr: pane.report_agent(working, session ref)
    Observer->>Herdr: agent.get(paneId)
    Herdr-->>Observer: working + session path

    Child->>Hook: agent_settled
    Hook->>Herdr: pane.report_agent(idle, session ref)
    Observer->>Herdr: agent.get(paneId)
    Herdr-->>Observer: idle
    Observer->>Herdr: agent.get(paneId)
    Herdr-->>Observer: stable idle
    Observer-->>Observer: completed outcome
```

Pi hooks are process-local. Herdr supplies the existing cross-process projection; this refactor does not add another child hook bridge.

## Pi session metadata and answer references

The observer carries references, not potentially large answer strings.

### Session reference

```ts
interface SessionRef {
  paneId: string;
  label: string;
  pi?: {
    id: string;
    path: string;
    cwd: string;
  };
}
```

- `paneId` and `label` identify the live Herdr session.
- `pi.path` is the preferred exact same-machine resume reference.
- `pi.id` and `pi.cwd` preserve Pi-native lookup context.
- `pi` is absent if the session header was not available before the outcome.

### Exact answer reference

```ts
interface SessionAnswerRef {
  path: string;
  entryId: string;
}
```

Pi session message entries already have stable IDs. An entry ID is safer than a byte offset or “latest answer” lookup because later turns can append to the same persistent session.

```mermaid
sequenceDiagram
    participant Observer as herdr/session.ts
    participant Herdr
    participant Access as pi-session.ts
    participant JSONL as Child session JSONL
    participant Tool as subagent-tool.ts

    Observer->>Herdr: agent.get(paneId)
    Herdr-->>Observer: status + session path
    Observer->>Access: inspectSession(path)
    Access->>JSONL: read header
    JSONL-->>Access: session id + cwd
    Access-->>Observer: Pi session metadata
    Note over Observer: Retain metadata for every later outcome

    Observer->>Herdr: observe stable settled state
    Observer->>Access: captureAnswerRef(path)
    Access->>JSONL: find latest terminal assistant entry
    JSONL-->>Access: entry ID
    Access-->>Observer: {path, entryId} or null
    Observer-->>Tool: completed outcome with reference

    Tool->>Access: readAnswer({path, entryId})
    Access->>JSONL: read exact entry
    JSONL-->>Access: assistant text parts
    Access-->>Tool: answer text or null
    Tool->>Tool: canonical byte/line truncation
```

The answer is extracted only while building final model-facing content. Structured details retain the reference, not a duplicate answer.

## Prompt-file lease lifecycle

A child agent's system prompt is written to a temporary file and passed through `--append-system-prompt`. The file is local launch infrastructure, not part of the delegated task outcome.

```mermaid
stateDiagram-v2
    [*] --> NoLease: empty system prompt
    [*] --> Created: prompt file written

    Created --> Released: confirmed launch failure
    Created --> DeferredRelease: launch indeterminate
    Created --> Launched: launch confirmed

    Launched --> Consumed: first Pi session path observed
    Launched --> CleanupRequested: observation ends before path observed
    Consumed --> Released: cleanup requested
    CleanupRequested --> Released: session path later observed
    CleanupRequested --> DeferredRelease: fallback timer
    DeferredRelease --> Released: fallback expires

    NoLease --> [*]
    Released --> [*]
```

Release is idempotent, non-throwing, and best-effort. It deletes only the temporary prompt directory; it never closes the pane or child Pi session.

## Outcome model

```mermaid
classDiagram
    direction LR

    class DelegatedTaskOutcome {
        <<union>>
    }
    class Invalid {
        status: invalid
        reason: empty_agent | empty_instruction | unknown_agent
        error: string
    }
    class Completed {
        status: completed
        session: SessionRef
        answer: SessionAnswerRef | null
    }
    class TimedOut {
        status: timed_out
        session: SessionRef
    }
    class Aborted {
        status: aborted
        stage: before_launch | observing
        session?: SessionRef
    }
    class SessionClosed {
        status: session_closed
        session: SessionRef
    }
    class LaunchFailed {
        status: launch_failed
        error: string
    }
    class LaunchIndeterminate {
        status: launch_indeterminate
        error: string
        possiblePaneId: string
    }
    class ObservationFailed {
        status: observation_failed
        session: SessionRef
        error: string
    }

    DelegatedTaskOutcome <|-- Invalid
    DelegatedTaskOutcome <|-- Completed
    DelegatedTaskOutcome <|-- TimedOut
    DelegatedTaskOutcome <|-- Aborted
    DelegatedTaskOutcome <|-- SessionClosed
    DelegatedTaskOutcome <|-- LaunchFailed
    DelegatedTaskOutcome <|-- LaunchIndeterminate
    DelegatedTaskOutcome <|-- ObservationFailed
```

The TypeScript union keeps the two abort variants separate so `session` is required only for `stage: "observing"`; the implementation does not rely on optional session state to distinguish them.

### Failure ownership

| Condition | Representation | Child may exist? | Pane remains live? |
|---|---|---:|---:|
| Malformed tool envelope | Pi schema error | No | N/A |
| Invalid task entry | Positional `invalid` outcome | No | N/A |
| Herdr environment unavailable | Throw before execution | No | N/A |
| Shared workspace unavailable | Throw before execution | No | N/A |
| Confirmed launch failure | `launch_failed` | No | N/A |
| Ambiguous `agent.start` | `launch_indeterminate` | Possibly | Possibly |
| Caller abort before launch | `aborted / before_launch` | No | N/A |
| Caller abort while observing | `aborted / observing` | Yes | Yes |
| Per-task timeout | `timed_out` | Yes | Yes |
| Pane closed | `session_closed` | Previously | No |
| Observation error | `observation_failed` | Yes | Yes |

Expected task-level conditions are data. Errors that prevent the delegation from beginning use Pi's native thrown tool-error channel.

## Cancellation flow

```mermaid
flowchart TD
    Signal([Abort signal]) --> Stage{Current stage}
    Stage -->|Before this task starts| Before[aborted / before_launch]
    Stage -->|Preflight, before agent.start| Before
    Stage -->|agent.start may have run| Ambiguous[launch_indeterminate]
    Stage -->|Confirmed session observing| Observing[aborted / observing]

    Before --> Stop[Do not launch later tasks]
    Ambiguous --> Protect[Do not reuse pane; defer prompt cleanup]
    Observing --> Keep[Stop observing; leave session live]
```

Cancellation controls the parent's work. It does not destroy child sessions.

## Final tool result

Structured details use one shape for one or many requested tasks:

```ts
interface SubagentToolDetails {
  tasks: Array<{
    taskNumber: number;
    agent: string;
    status: DelegatedTaskOutcome["status"];
    session?: SessionRef;
    answer?: SessionAnswerRef;
    stage?: "before_launch" | "observing";
    reason?: string;
    error?: string;
    possiblePaneId?: string;
  }>;
}
```

There is no `mode`, `success`, `invocationId`, display-target duplication, or answer-text duplication.

### Single task

One requested task returns its direct answer or exact status-specific explanation.

```text
<answer text>
```

### Multiple tasks

```markdown
Delegation: 2/4 tasks completed

### Task 1 — code-reviewer — completed

<answer>

---

### Task 2 — missing-agent — invalid

Unknown agent "missing-agent". Available agents: ...

---

### Task 3 — researcher — timed out

The delegated turn timed out after 20 minutes. The visible session remains available in pane ...

---

### Task 4 — reviewer — launch indeterminate

Herdr may have launched this session. Inspect the possible pane before retrying.
```

Task number is canonical. Agent name is descriptive. Exact outcome vocabulary is preserved rather than flattening every non-completed state to “failed.”

Completed answers use Pi's canonical 50 KiB/2,000-line head truncation. The full answer remains in the referenced child session entry.

## Invariants

1. A requested task receives one one-based `taskNumber` exactly once.
2. No second task identity or invocation correlation ID is generated.
3. Structurally valid task entries produce exactly one final positional outcome, including invalid entries.
4. Valid sibling tasks execute even when another task is invalid.
5. Herdr setup may throw only before any child launch begins.
6. Once launch processing begins, known operational conditions become task outcomes.
7. Launches occur sequentially in original valid-task order.
8. Observation begins immediately after each confirmed launch and may complete out of order.
9. Final outcomes and presentation return to original requested-task order.
10. A delegated turn ending never implies that its visible subagent session ended.
11. Timeout and cancellation never close a confirmed child session.
12. Indeterminate launches never reuse the possibly occupied pane.
13. Prompt resources remain until consumption is known or the conservative fallback expires.
14. Final answer extraction uses the exact persisted message entry observed at settlement.
15. Agent discovery and the tool description use the same session-scoped catalog snapshot.

## Test seams

```mermaid
flowchart LR
    ToolTests[Tool policy tests] --> FakeExecute[Injected executeHerdrDelegation function]
    DelegationTests[Delegation/session tests] --> FakeRpc[Scripted HerdrRpc adapter]
    RpcTests[Transport tests] --> FakeSocket[Temporary Unix socket server]
    SessionTests[Pi session tests] --> TempJSONL[Temporary JSONL files]
    AgentTests[Catalog tests] --> TempAgents[Temporary agent directories]
```

- Tool tests verify strict request policy, mixed valid/invalid tasks, numbering, merging, normalized details, presentation, and truncation.
- Delegation/session tests verify placement, sequential launch, immediate observation, launch certainty, cancellation, timeout, prompt leases, and ordered outcomes.
- RPC tests verify NDJSON framing, response matching, timeout, abort, and response errors.
- Pi session tests verify header capture, exact terminal entry references, later-turn exclusion, malformed lines, and missing answers.
- Catalog tests verify trust, nearest project discovery, precedence, and session snapshot consistency.

Tests cross the same deep interfaces used by production. They do not call private methods or cast constructors through `any`.

## Future extraction

A future non-Herdr runtime is deliberately not represented today. The potential extraction seam is the single call from `subagent-tool.ts` to `executeHerdrDelegation()`.

If a second concrete runtime is built, compare the two implementations and extract only their proven shared task/outcome contract. The Herdr-specific `session.ts` and `rpc.ts` remain behind that future seam.
