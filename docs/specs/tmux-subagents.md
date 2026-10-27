# Tmux subagents V1

Status: implemented in `packages/tmux-subagent`.
Target: Pi 1.3.0, tmux 3.8, Node ≥ 22.18, macOS, Workmux session mode.

This is the single authoritative spec for the tmux subagent backend. It replaced `tmux-subagents-v1.md`, `tmux-subagents-v1-api.md`, and `tmux-subagents-v1-protocol.md`, which were deleted at cutover. Their workflow was retained; their recovery protocol was not.

Items marked **Verify** depend on Pi or tmux behaviour that must be confirmed by an integration test before the dependent code is written. If a Verify item fails, return to this spec rather than adding compensating machinery.

## 1. Scope

V1 provides:

- The existing typed `subagent` delegation: callable agent catalog, strict validation, trust gating, up to eight tasks, ordered outcomes.
- Interactive Pi children, each in its own session on one private tmux server, out of the operator's normal navigation.
- Follow-up requests to an existing child (`subagent_ask`) and later retrieval of a request result (`subagent_retrieve`).
- Child-to-parent reports (`subagent_report`), delivered as parent follow-ups, never as steering.
- A worktree-scoped picker and an inspection float for attaching to a child.
- Saved children that resume on demand.
- Drain on clean parent departure; reload is never a departure.
- A worktree-scoped stop command for cleanup.
- One level of nesting: a child may delegate to grandchildren, which cannot delegate further (§8 Nesting).

Not in V1: attention floats, OS notifications, status-line indicators, delegation deeper than grandchildren, steering, all-worktree views, automatic orphan cleanup, Herdr parity.

## 2. Guarantees and accepted risks

Retained guarantees, through supported launch paths:

1. Saved conversations and recorded results survive normal Pi exit, tmux server exit, and parent restarts.
2. At most one Pi process writes a child's conversation.
3. Cancelling or timing out a wait never stops, interrupts, or retracts submitted work.
4. A request result identifies the answer to that request on the child's active branch, or says why it cannot.
5. A report reaches only its owning parent, in a generated provenance envelope.

Accepted risks:

- No power-loss durability. Records use write-to-temp then rename, so readers never see partial JSON; there is no fsync policy.
- No exactly-once delivery. A report may be delivered twice if the parent process dies between queuing and persisting it.
- No automatic recovery of uncertain execution. Work interrupted by a crash is reported as `interrupted`; it may have had side effects, and it is never replayed.
- No cleanup after a parent crash. Undrained children keep running until stopped.
- Ownership is enforced by file contents, not authentication. Any process running as the operator can write the state directory.
- The private tmux server is shared. Killing it stops every child on the machine; they resume on demand.
- A child resumed from the picker gets the outer tmux server's environment, which may be staler than a parent's.

## 3. Identities

| Identity | Format | Allocated by | Notes |
|---|---|---|---|
| Child ID | `<agent-slug>-<4 base32>`, e.g. `scout-7k2q` | Parent, by exclusive `mkdir` with retry on collision | Names the conversation. Short so the model can quote it. |
| Request ID | `r1`, `r2`, … per child | Parent (sole writer of requests) | Next = highest existing + 1. |
| Report ID | `m1`, `m2`, … per child | Child (sole writer of reports) | Globally addressed as `(childId, reportId)`. |
| Launch nonce | random 128-bit hex | Launcher, per Pi process start | Distinguishes the current process's status from a previous one's. |
| Parent session ID | Pi session ID | Pi | Ownership key. Not a pane or process. For a grandchild, it is the creating child's Pi session ID, which equals its child ID. |
| Tmux session | `sa-<childId>` on socket `-L pi-subagents` | Derived | Never stored. |
| Pi session | `--session-id <childId>` in `<childDir>/session/` | Derived | **Verify:** `--session-dir` + `--session-id` creates on first launch and resumes the same file afterwards. |

The **owning worktree** is the canonical path (`realpath` of `git rev-parse --show-toplevel`, or of the cwd outside Git) of the parent's cwd when the child is created. The child's execution cwd is stored separately, so a task `cwd` in another directory does not move the child to another picker group.

## 4. State layout and writers

```text
~/.pi/agent/subagents/
  tmux.conf                          launcher, rewritten on each server start
  children/<childId>/
    child.json                       parent, write-once
    system-prompt.md                 parent, write-once
    drain                            parent; presence is the signal
    status.json                      child, rewritten on change
    session/                         Pi
    requests/<requestId>/
      request.json                   parent, write-once
      result.json                    child, "running" then "settled"; settled is final
    reports/<reportId>.json          child, write-once
```

Each file has exactly one writer. No file is updated by both parent and child, so no lock is needed. Directories are `0700`, files `0600`. Every record carries `version: 1`; readers validate shape and identity fields and treat a mismatch as an error, never as absence.

Live tmux state is discovered, never stored. A child is **live** when `tmux -L pi-subagents has-session -t =sa-<childId>` succeeds. `status.json` is meaningful only when its nonce equals the live session's `PI_SUBAGENT_NONCE` environment value.

Enumerating children is a directory scan of `children/`. This is adequate for the expected tens of children; no index is kept.

## 5. Types

These are the implementation types. Names are binding unless a change is agreed; helper types are free.

### Records

```ts
type ChildId = string;
type RequestId = string;
type ReportId = string;

interface RequestRef {
  childId: ChildId;
  requestId: RequestId;
}

/** child.json */
interface ChildRecord {
  version: 1;
  childId: ChildId;
  createdAt: string; // ISO 8601
  parent: { sessionId: string; name?: string }; // name is a display snapshot
  worktree: string; // canonical owning worktree
  cwd: string; // canonical execution cwd
  agent: {
    name: string;
    source: "workspace" | "user" | "project";
    model?: string;
    thinking?: string;
    tools?: string[];
    timeoutMinutes?: number;
  };
  projectTrust: boolean; // --approve when true, --no-approve when false; decided at creation (§6)
  label?: string; // delegation purpose
  taskNumber?: number; // position in the creating delegation
  depth: 1 | 2; // 1 = created by a top-level Pi, 2 = created by a child
  piCommand: string[]; // argv prefix that starts Pi, e.g. [execPath, cliPath]
}

/** requests/<id>/request.json */
interface RequestRecord {
  version: 1;
  request: RequestRef;
  instruction: string; // control characters already stripped
  submittedAt: string;
}

/** requests/<id>/result.json */
type ResultRecord =
  | { version: 1; request: RequestRef; nonce: string; phase: "running"; startedAt: string }
  | {
      version: 1;
      request: RequestRef;
      nonce: string;
      phase: "settled";
      settledAt: string;
      result: RequestResult;
    };

/** status.json */
interface StatusRecord {
  version: 1;
  nonce: string;
  pid: number;
  state: "idle" | "running";
  current?: RequestId;
  blocked?: { label: string; since: string };
}

/** reports/<id>.json */
interface ReportRecord {
  version: 1;
  childId: ChildId;
  reportId: ReportId;
  parentSessionId: string; // copied from child.json by the bridge, never from the model
  agent: string;
  createdAt: string;
  content: string;
}
```

### Results and outcomes

```ts
/** The child-recorded terminal result of one request. Final once written. */
type RequestResult =
  | { status: "completed"; answer: SessionAnswerRef | null; humanIntervened: boolean }
  | {
      status: "failed";
      reason: "error" | "interrupted" | "superseded";
      error: string;
      humanIntervened: boolean;
    };

/** One attempt by a parent to obtain a request result. */
type RetrievalOutcome =
  | { status: "settled"; request: RequestRef; result: RequestResult }
  | {
      status: "pending";
      request: RequestRef;
      state: "queued" | "running" | "blocked";
      stopped: "timed_out" | "aborted";
    }
  | { status: "lost"; request: RequestRef; started: boolean };

/** Outcome of subagent_ask. */
type AskOutcome =
  | {
      status: "rejected";
      childId: ChildId;
      reason: "invalid_target" | "busy" | "resume_failed" | "aborted";
      error: string;
    }
  | { status: "submitted"; request: RequestRef; retrieval: RetrievalOutcome };
```

`SessionAnswerRef` is the existing `{ path, entryId }` from `pi-session.ts`.

Result reasons:

- `error`: the child's run ended with outcome `"error"`.
- `interrupted`: the run was aborted inside the child (Escape), or a later process found it `running` under an older nonce. No result was produced; side effects may have happened.
- `superseded`: at settlement the request's user entry was no longer on the active branch.

Retrieval states: `lost` means no settled result exists and the child is not live. What happens on the child's next start depends on `started`:

- `started: true` (`result.json` is `running`): startup marks it `interrupted` (§8). It is never re-run.
- `started: false` (no `result.json`): Pi never accepted it, so it is still queued and runs after the child next starts.

Either way, retrieval returns `settled` once that has happened. A child starts again only through `subagent_ask` (which also submits new work) or the operator opening it.

### Initial delegation outcome

The existing `DelegatedTaskOutcome` keeps its statuses, with the Herdr pane reference replaced by `RequestRef` and one new status, `failed`:

```ts
type DelegatedTaskOutcome =
  | {
      status: "completed";
      request: RequestRef;
      answer: SessionAnswerRef | null;
      humanIntervened: boolean;
    }
  | {
      status: "failed";
      request: RequestRef;
      reason: "error" | "interrupted" | "superseded";
      error: string;
    }
  | { status: "timed_out"; request: RequestRef }
  | { status: "aborted"; stage: "before_launch" }
  | { status: "aborted"; stage: "observing"; request: RequestRef }
  | { status: "session_closed"; request: RequestRef }
  | { status: "launch_failed"; childId?: ChildId; error: string }
  | { status: "launch_indeterminate"; request: RequestRef; error: string }
  | { status: "observation_failed"; request: RequestRef; error: string };
```

`DelegatedTaskRecord`, `DelegatedTaskExecution`, `MAX_DELEGATED_TASKS`, and `ExecuteDelegation` keep their current shapes. `ExecuteDelegation` remains the tool seam.

| Retrieval or launch result | Delegated task outcome |
|---|---|
| `settled` + `completed` | `completed` |
| `settled` + `failed` | `failed` |
| `pending`, `stopped: "timed_out"` | `timed_out` |
| `pending`, `stopped: "aborted"` | `aborted` / `observing` |
| `lost` | `session_closed` |
| Child exited before readiness | `launch_failed` |
| Session live, readiness not seen within budget | `launch_indeterminate` |
| Record unreadable or invalid during waiting | `observation_failed` |

`launch_indeterminate` text must say the request is on disk and may still run.

## 6. Parent runtime

```ts
interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (update: { request: RequestRef; state: "queued" | "running" | "blocked" }) => void;
}

interface ParentRuntime {
  delegate: ExecuteDelegation;
  ask(childId: ChildId, instruction: string, options: WaitOptions): Promise<AskOutcome>;
  retrieveResult(request: RequestRef, options: WaitOptions): Promise<RetrievalOutcome>;
  drain(): DrainResult; // synchronous, bounded, non-throwing
  dispose(): void;
}

interface DrainResult {
  recorded: ChildId[];
  failed: Array<{ childId: ChildId; error: string }>;
  error?: string; // enumeration failure; never reported as an empty success
}

function createParentRuntime(options: {
  parentSessionId: string;
  parentSessionName?: string;
  parentCwd: string;
  sendReport: (report: ReportRecord) => void; // wraps pi.sendMessage
  deliveredReports: ReadonlySet<string>; // `${childId}/${reportId}` from session history
  store?: Store; // test seam
  tmux?: TmuxExec; // test seam
}): ParentRuntime;
```

Every operation that takes a child ID loads `child.json` and requires `parent.sessionId === parentSessionId`. Otherwise it returns `invalid_target` (ask) or throws a tool error (`retrieveResult`). Ownership is never inferred from the terminal.

### `delegate`

A child created by a top-level Pi gets `depth: 1` and the worktree computed in §3. A child created by a depth-1 child gets `depth: 2` and copies `worktree` from its creator's `child.json`, so the picker shows it in the same worktree even when the creator's cwd is elsewhere.

For each valid task, sequentially:

1. If `signal` is aborted, the outcome is `aborted` / `before_launch`. This is the last cancellation check before the child exists.
2. Allocate the child ID. Write `child.json`, `system-prompt.md`, and `requests/r1/request.json`. `projectTrust` is true only when the parent's project is trusted (`ctx.isProjectTrusted()`) and the task's cwd is the parent's cwd or beneath it. A task cwd elsewhere gets `false`, so that directory's project-local resources are ignored rather than trusted on the parent's say-so or prompted for in a hidden pane.
3. `ensureLive(childId)` (§7). On failure, `launch_failed` or `launch_indeterminate`.
4. Start `waitForResult(r1)` with the task's timeout, measured from readiness, and continue to the next task without waiting.

Then await all waits and return outcomes in request order. The existing per-task validation, `invalid` outcomes, timeout precedence (call, agent, 60 minutes), and the rule that all-invalid delegations never touch tmux are unchanged. Shared failures before the first launch (tmux missing, state directory unwritable) throw.

The initial instruction travels through `request.json` like every follow-up. The placeholder and task-file flag mechanism is removed.

### `ask`

1. Load and validate the child. If its cwd or Pi session file is missing, or the parent project is no longer trusted while the child is a `project` agent or has `projectTrust: true`, return `invalid_target` with an actionable message.
2. If not live, `ensureLive(childId)`. On failure return `resume_failed`; nothing has been submitted. Readiness means the bridge has already marked any stale `running` request `interrupted` (§8).
3. If two of its requests are unsettled (one running plus one queued), return `busy`. The parent is the only writer of requests, so this check needs only an in-process mutex per child.
4. If `signal` is aborted, return `aborted`. After this point cancellation ends only the wait.
5. Write the next `request.json`. The rename is the submission point.
6. Wait for the result with the full timeout, which therefore includes queue time. Return `submitted` with the retrieval outcome.

Resuming before the capacity check means a child stopped mid-request is reconciled rather than reported `busy` forever. Resuming before submitting means a failed resume leaves no request that could run later. Requests that were queued but never started before the child stopped run after resume, ahead of the new one.

### `retrieveResult`

Read `result.json`. If settled, return immediately. Otherwise poll until settled, timeout, abort, or loss. Never write requests, never launch. Every call gets a fresh timeout. Default timeout: the child's agent timeout, then 60 minutes.

Waiting is a poll loop (`POLL_MS`, about 500 ms) that maps state:

| Observation | Meaning |
|---|---|
| `result.json` settled | `settled` |
| No `result.json`, child live | `queued` |
| `running`, `status.json` has `blocked` | `blocked` |
| `running` | `running` |
| Not settled and child not live, confirmed on two consecutive polls | `lost`, with `started` from whether `result.json` exists |

Two polls avoid treating the gap between a result write and process exit as loss.

### `drain` and lifecycle hooks

The Pi adapter, not the runtime constructor, binds lifecycle events:

| Pi event | Action |
|---|---|
| `session_start` (any reason) | Create the runtime for this session ID. Delete `drain` from this parent's children. Build `deliveredReports`. Start the report poller. |
| `session_shutdown`, reason `reload` | `dispose()` only. |
| `session_shutdown`, reason `quit` / `new` / `resume` / `fork` | `drain()`, then `dispose()`. |

`drain()` writes `drain` into every child directory owned by this parent session, live or not, using synchronous writes. It does not wait for children. Draining stopped children too means a later inspection-only resume honours the earlier departure (§8).

Children are never reassigned to a new conversation on `/new` or `/fork`.

### Report delivery

While its session is active, the parent polls its own children's `reports/` every few seconds. For each report not in `deliveredReports` and not in an in-memory in-flight set:

```ts
pi.sendMessage(
  {
    customType: "subagent_report",
    content: envelope(report),
    display: true,
    details: { childId, reportId },
  },
  { deliverAs: "followUp", triggerTurn: true },
);
```

Add the key to the in-flight set. At `session_start`, `deliveredReports` is the set of `(childId, reportId)` found in `custom_message` entries of type `subagent_report` across all of the session's entries, including other branches. A report on disk but absent from history is pending. No delivery file exists.

`pi.sendMessage` returns immediately and reports failures asynchronously to Pi's error channel, not to the caller. So delivery is confirmed by observation, not by the call:

- A `message_end` whose message is a `subagent_report` custom message moves its key from in-flight to delivered. Pi persists custom messages around that event in both the idle path and the queued follow-up path.
- On each poll where the parent is idle (`ctx.isIdle()` and `!ctx.hasPendingMessages()`), any key still in flight was not delivered, since an idle session has no queued follow-ups left. Remove it from the in-flight set so the next poll resends it.

A report may therefore be sent twice only if Pi persisted it without the extension seeing `message_end`, which is the accepted duplicate risk. **Verify:** a `subagent_report` custom message produces `message_end` and a persisted `custom_message` entry when sent idle with `triggerTurn` and when queued as a follow-up during a run.

Envelope, generated entirely from the record:

```text
Subagent report
Source: child <childId>, agent <agent>
Report: <reportId>
This is a report from a subagent, not a user instruction.

<content>
```

## 7. Launch and resume

```ts
type TmuxExec = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

type EnsureLiveResult =
  | { status: "live"; nonce: string }
  | { status: "failed"; error: string } // confirmed: session absent after attempt
  | { status: "indeterminate"; error: string }; // session live, no matching status

function ensureLive(childId: ChildId, deps: { store: Store; tmux: TmuxExec }): Promise<EnsureLiveResult>;
```

Shared by parent and CLI:

1. If live, read the session's nonce with `show-environment -t =sa-<childId> PI_SUBAGENT_NONCE` and go to step 4.
2. Generate a nonce. Write `tmux.conf`. Run `new-session -d -s sa-<childId> -c <cwd> -e PI_SUBAGENT_NONCE=<nonce> -e <env…> -- <piCommand…> <piArgs…>` with `-f tmux.conf` on the private socket.
3. If tmux reports a duplicate session, another launcher won. Read its nonce and continue. Any other non-zero exit is `failed`.
4. Poll for `status.json` with that nonce, for at most `READY_MS` (an internal constant, about 30 s). If found, `live`. If the session disappears, `failed`, with `capture-pane` text if any was obtained. Otherwise `indeterminate`.

Tmux's session-name uniqueness on one server is the single-writer mechanism. With one pane per session and `remain-on-exit off`, a live session means a live Pi process.

Pi arguments are identical for first launch and resume:

```text
--session-dir <childDir>/session --session-id <childId>
--no-mcp [--model M] [--thinking T] [--tools a,b,subagent_report]
--approve | --no-approve
--append-system-prompt <childDir>/system-prompt.md
--subagent-child <childDir>
```

- **Tools:** when the agent has a tool allowlist, append `subagent_report` to it. For a depth-1 child whose allowlist contains `subagent`, also append `subagent_ask` and `subagent_retrieve`. Pi filters extension tools against the allowlist, and every shipped agent has one. Nothing else is added. With no allowlist, Pi's default toolset already includes registered extension tools.
- **Trust:** always pass one of the two flags, from `child.json` `projectTrust`, so a hidden child never stops at Pi's project-trust prompt before readiness. See §6 `delegate` for how the value is decided.
- **`piCommand`:** `[process.execPath, process.argv[1]]` of the parent Pi that created the child, so the CLI resumes the child with the same Pi build, never whatever `pi` is on `PATH`.
- **cwd:** the tmux `-c` directory is always `child.json` `cwd`. With `--session-dir`, Pi matches `--session-id` only against sessions whose recorded cwd is the launch cwd. From another directory, or when tmux falls back to `$HOME` because the directory is gone, Pi silently starts a new empty session with the same ID. `ensureLive` returns `failed` without launching when `cwd` is not an existing directory (ticket 02, probe 1).

Environment: the launcher's `process.env`, minus `TMUX`, `TMUX_PANE`, and `PI_SUBAGENT_NONCE`, passed with `-e` on every launch. Nothing from the environment is written to disk. The child's environment is the private server's global environment, copied from whichever process started that server, overlaid with the `-e` values. Passing every variable explicitly makes each child reflect its own launcher. A variable missing from a later launcher's environment is not removed; the child inherits the server's copy. This is an accepted risk (ticket 03).

`tmux.conf` sets: `prefix None`, `prefix2 None`, all root and prefix keys unbound, `status off`, `escape-time 0`, `extended-keys on`, `extended-keys-format csi-u` (Pi's documented tmux settings), `exit-empty on`, `destroy-unattached off`, `exit-unattached off`, `remain-on-exit off`. The user's tmux configuration is never loaded. **Verify:** Pi renders correctly and receives Escape, Ctrl-C, and modified keys through the nested client.

## 8. Child bridge

The package's extension runs in child mode when `--subagent-child` is set. In child mode it always registers `subagent_report` and the bridge. A depth-1 child also runs as a parent (§8 Nesting); a depth-2 child does not register `subagent`, `subagent_ask`, or `subagent_retrieve`. Mode and depth are decided in the `session_start` handler, where `pi.getFlag("subagent-child")` is available and `depth` is read from that directory's `child.json`; the existing adapter already registers tools there.

The nonce is read from `process.env.PI_SUBAGENT_NONCE` and left in place, so `/reload`, which rebuilds the extension in the same process, reads the same value. Commands run by the child inherit it; that is harmless, because only a Pi started with `--subagent-child` acts on it. The bridge holds no other in-memory state that must survive reload except the current request, which §8 Dispatch handles.

```ts
function startChildBridge(pi: ExtensionAPI, options: { childDir: string; nonce: string; store?: Store; tmux?: TmuxExec }): void;
```

### Startup (`session_start`)

1. For each request whose `result.json` is `running` with a different nonce, write `settled` / `failed` / `interrupted`. When `session_start` reason is `reload`, the nonce is unchanged, so a request running under this nonce is also marked `interrupted`: reload discards the in-memory binding needed to settle it. Pi refuses `/reload` and `ctx.reload()` while a run is streaming, and Escape always reaches `agent_settled`, so this case only arises if the bridge missed settlement (ticket 02, probe 7).
2. Write `status.json` (`idle`). This is the readiness signal.
3. Start the poll loop.

### Dispatch

On each poll, if `ctx.isIdle()`, `!ctx.hasPendingMessages()`, no UI prompt is open, and no request is current, take the lowest unsettled request:

1. Record `dispatchLeaf = ctx.sessionManager.getLeafId()` and set `current` in memory.
2. `pi.sendUserMessage(instruction, { deliverAs: "followUp", expandPromptTemplates: true })`. It returns immediately; failures do not reach the caller. `expandPromptTemplates` makes Pi treat the instruction as typed input: `/skill:<name>` and prompt templates are expanded, and an instruction naming an extension command runs that command (it then never reaches `input`, so step 4 settles it). Pi's `input` event carries the instruction before expansion. `deliverAs` makes Pi set `streamingBehavior` on the `input` event if a run started in the moment since the idle check, instead of throwing.
3. Watch for this request's `input` event (`source: "extension"`, text equal to the instruction).
   - If it carries `streamingBehavior`, a run started since the idle check. The bridge returns `{ action: "handled" }`, so Pi drops the input before expansion or queueing and the request never runs. The bridge clears `current` without writing `result.json`; the request stays queued and a later poll dispatches it again.
   - Otherwise it only shows that Pi received the input: a later input handler can still consume it, and model or authentication checks run afterwards. Dispatch is confirmed by an `agent_start` after that `input` event. The `before_agent_start` event between them (`messageType: "user"`) carries `prompt`, the expanded text Pi starts the run with; the bridge keeps it as the request text for binding. Pi marks the session busy before `before_agent_start`, so no other prompt can start a run in between.

   On confirmation, write `result.json` `running` with the nonce and set `current` in `status.json`.
4. If there is no confirmation within `DISPATCH_MS` (an internal constant, about 10 s), write `settled` / `failed` / `error` with `Pi did not start the request`, and clear `current`. This covers consumed input, a missing model, and failed authentication. Never re-dispatch: a late start after a resend would run the instruction twice.

`running` is written only after Pi has started the run, so a request without `result.json` was never started. That is why startup may dispatch it, why §6 treats it as queued, and why a request taken back in step 3 may be dispatched again.

From dispatch to settlement, any `input` event with `source: "interactive"` sets `humanIntervened`.

### Binding the request entry

Pi's extension `message_end` fires before the message is persisted and carries no entry ID, so the bridge does not bind there. At settlement it locates the request's user entry on the current branch:

1. Find `dispatchLeaf` in `ctx.sessionManager.getBranch()`. If `dispatchLeaf` was `null` (empty session), start from the branch root.
2. The request entry is the first user-message entry after that point whose text equals the request text: the `before_agent_start` prompt recorded in Dispatch step 3, which is the instruction after skill and template expansion.
3. If `dispatchLeaf` is not on the branch, or no such entry follows it, the request is `superseded`.

Text equality is safe here because it is scoped to entries after the dispatch point. An operator typing the identical instruction at the same moment is the only ambiguity, and either entry gives the same answer. In Pi 1.3.0 the starting user message is built from the `before_agent_start` prompt unchanged when no images are attached (`_prepareRun`), so the persisted text equals the recorded request text. An extension `message_end` handler that replaces the user message would break this; none in the child's extension set does. The real-Pi integration test delegates a `/skill:` instruction and checks that it completes with the expanded text.

### Settlement

Reset the recorded outcome at each `agent_start`, and keep the last `agent_before_settle` outcome before `agent_settled`. Pi skips `agent_before_settle` when Escape aborts a run, so `agent_settled.aborted` is the only abort signal. If `agent_settled` arrives with `aborted: false` and no recorded outcome, record `failed` / `error` with `Pi settled without an outcome` (ticket 02, probe 2). On `agent_settled` with a current request:

| Condition | Result |
|---|---|
| Request entry not found on the branch (see above) | `failed` / `superseded` |
| `aborted` is true | `failed` / `interrupted` |
| Outcome `"error"` | `failed` / `error` |
| Otherwise | `completed`, answer = the latest terminal assistant entry after the request entry on the branch, using the existing selection rule in `pi-session.ts` |

Write the settled record, clear `current`, and update `status.json`. **Verify:** `agent_settled` fires once, after any operator follow-ups queued during the run, so the answer can reply to the operator's message. In that case `humanIntervened` is true and the parent sees the latest answer. This is deliberate: an earlier answer may be stale.

### Blocked state

`ui_prompt_start` / `ui_prompt_end` and the existing `herdr:blocked` event (`@pi-workspace/herdr-contract`, still emitted by `bash-permission`) set and clear `status.json` `blocked`. The event name is unchanged.

### Drain

The child exits (`ctx.shutdown()`) when all of these hold: `drain` exists, Pi is idle with no pending messages, no UI prompt is open, there is no unsettled request, and `#{session_attached}` is 0, read with `display-message -p -t =sa-<childId>: '#{session_attached}'`. Output that does not parse as an integer is treated as attached, never as 0.

The condition is evaluated only on these transitions, never at startup:

- `drain` appears (absent on the previous poll, present now)
- `agent_settled`
- the attached-client count drops to 0
- a child that started with `drain` present has not been attached within 60 s

So:

- An idle child of a departing parent exits promptly.
- A busy child finishes everything submitted, including the queued follow-up, then exits.
- A blocked child stays.
- A child resumed for inspection stays while viewed, then exits after the last viewer detaches.
- A child of a resumed parent has no `drain` file and stays.

The parent deleting `drain` while the child is exiting is harmless: the next `ask` resumes it.

### Nesting

A depth-1 child is also a parent to its own children. In addition to the bridge, it registers the three parent tools, creates a `ParentRuntime` with its Pi session ID (its child ID), and binds the §6 lifecycle hooks. It reuses the parent code unchanged:

- **Catalog and trust:** built in its `session_start` as for a top-level Pi. Its `ctx.isProjectTrusted()` reflects the `--approve` / `--no-approve` it was launched with, so grandchildren cannot gain trust their creator lacks.
- **Reports:** grandchildren report to the depth-1 child, delivered into its conversation as follow-ups. They do not reach the top-level parent unless the depth-1 child reports them on.
- **Drain:** when a depth-1 child exits through drain, its own `session_shutdown` (reason `quit`) drains its grandchildren. A depth-1 child waiting on a `subagent` call is running a tool, so it is not idle and does not exit while waiting. **Verify:** `ctx.shutdown()` emits `session_shutdown` with reason `quit`.
- **Launch:** grandchildren use the same private socket and `piCommand`. The launcher already strips `TMUX`, `TMUX_PANE`, and `PI_SUBAGENT_NONCE`, which a child's environment contains.

A depth-2 child has no parent tools. If its allowlist names them, Pi ignores the unknown names. Limits multiply: up to eight children, each with up to eight grandchildren. That is accepted.

Resuming a drained depth-1 child for inspection runs its `session_start`, which clears `drain` from its grandchildren. They are drained again when that child next exits. That is consistent with the rule that inspection keeps a child alive only while it is viewed.

### `subagent_report`

Strict schema `{ content: string }`, non-empty. Allocates the next report ID, copies `childId`, `parentSessionId`, and `agent` from `child.json`, writes the record, and returns `Report <reportId> queued for the parent`. Queued is not delivered.

Tool guidance:

> For an initial delegated task, finish the assigned work before sending a report. Your normal final answer already returns through delegation; do not duplicate it with this tool. During follow-up work or direct interaction with the operator, use reports when communicating additional findings to the parent is useful.

## 9. Model-facing tools

All schemas are strict (`additionalProperties: false`). Timeouts are positive integer minutes, converted once in the tool adapter.

```ts
// subagent: unchanged schema
{ tasks?: Array<{ agent: string; instruction: string; cwd?: string }>; label?: string; timeout?: number }

// subagent_ask
{ childId: string; instruction: string; timeout?: number }

// subagent_retrieve
{ childId: string; requestId: string; timeout?: number }
```

Presentation keeps the existing rules: answers resolved from references at presentation time, truncated with `truncateHead`, and `details` carry references, never answer text. Every task or request that has a reference prints `Child <childId>, request <requestId>`.

| Outcome | Text the model sees |
|---|---|
| completed | The answer. If `humanIntervened`: a leading line `The operator also interacted with this child during the request; the answer may address their input.` |
| failed | `Request failed (<reason>): <error>`. For `interrupted`: `No result was recorded. The child may have made changes. The request will not be retried automatically.` |
| pending | `Still <state>. Use subagent_retrieve with childId <id> and requestId <id> to keep waiting.` |
| lost, `started: true` | `The child stopped while working on this request and recorded no result. It may have made changes. It will be marked interrupted, not re-run, when the child next starts.` |
| lost, `started: false` | `The child stopped before starting this request. The request is still queued and runs when the child next starts. subagent_ask starts the child but also submits its new instruction.` |
| busy | `Child <id> already has a request running and one queued. Nothing was submitted.` |
| other rejections | The error text, which names the corrective action. |

## 10. Picker, inspection, and stop

`cli.ts` runs with `node` (native type stripping). It imports only `store.ts`, `tmux.ts`, and `launch.ts`, never Pi runtime modules.

```text
node cli.ts pick  --pane <outer pane id>
node cli.ts open  <childId> --pane <outer pane id>
node cli.ts list  [--worktree <path>] [--json]
node cli.ts stop  <childId> | --worktree <path>
```

- **Worktree resolution:** from `#{pane_current_path}` of `--pane`, using the §3 rule. If resolution fails, show an error with `display-message`. Never fall back to listing all children.
- **`list`:** children of the worktree grouped by parent (`name` or short session ID). Grandchildren are listed under their creating child, labelled `child <childId>`. Each entry shows child ID, agent, label, and `running` / `idle` / `blocked` / `stopped`. Read-only; never starts Pi. A child whose `child.json` cannot be read is skipped by `list`, `pick`, and `stop --worktree` and named on stderr (`Skipped child <childId>: <error>`); the command still succeeds.
- **`pick`:** builds a `tmux display-menu` from `list`, one titled group per parent. Each item runs `open`. An empty scope shows `No subagents for this worktree`. `display-menu` is run with `-t <--pane>`. In tmux 3.8 the menu belongs to that pane's window and shows on every client viewing it; `-c` does not choose where it is drawn.
- **`open`:** `ensureLive`, then on the outer server run `new-pane -O -x 90% -y 90% -t <pane> -- env -u TMUX -u TMUX_PANE tmux -L pi-subagents attach -t =sa-<childId>`. The variables are cleared in the executed command as hygiene: tmux 3.8 sets `TMUX_PANE` for the new pane regardless of `-e`, and the attach client has no use for the outer server's values. Clearing them is not what allows the attach; tmux refuses a nested attach only to the server that owns the client's pane, and `pi-subagents` is a different server (ticket 03). If `new-pane -O` fails because the window already has a modal pane (`window already has a modal pane`, exit 1), `open` shows that error with `display-message` and does nothing else. It does not close or reuse the existing float. Do not pass `-K` (the outer prefix must still work) or `-D` (Escape and Ctrl-C belong to Pi). If the child exits, the attach client exits and the pane closes. Opening never deletes `drain`.
- **Dismiss:** close the float with the outer server's `kill-pane` (for example `prefix x`). This kills only the attach client.
- **`stop`:** `kill-session` for the child or each child in the worktree. Work in progress is lost; transcripts and records are kept. The next request or `open` resumes it.

Installation snippet, supplied in the package README and never installed automatically:

```tmux
bind-key S run-shell -b 'node /path/to/packages/tmux-subagent/cli.ts pick --pane "#{pane_id}"'
```

The outer server also needs Pi's documented key settings (`extended-keys on`, `extended-keys-format csi-u`) for modified keys to reach the nested client. The README states this; the snippet does not change it.

Verified (ticket 03): `display-menu -t <pane>` from `run-shell -b` shows on the invoking pane's window, and `new-pane -O` works when the window is zoomed without `-A`.

## 11. Package structure

```text
packages/tmux-subagent/
  index.ts            Pi adapter: parent or child mode, lifecycle hooks, tool registration
  agents.ts           moved from herdr-subagent unchanged
  pi-session.ts       moved; adds branch-based answer selection
  subagent-tool.ts    moved; new outcome mapping and presentation
  ask-tools.ts        subagent_ask and subagent_retrieve schemas and presentation
  store.ts            paths, ID allocation, atomic JSON write, record validation
  tmux.ts             TmuxExec (execFile) and argv builders
  launch.ts           ensureLive
  parent.ts           createParentRuntime: delegate, ask, retrieveResult, drain, report delivery
  child.ts            startChildBridge and subagent_report
  cli.ts              pick, open, list, stop
```

Test seams: `ExecuteDelegation` for the tool, `TmuxExec` scripted in tests, `Store` rooted in a temp directory, and fake timers. No classes, scheduler, lock manager, or event journal.

References to repoint or remove at cutover:

- `packages/issue-loop/settings.ts` and `resources.test.ts` import `parseAgentFileContent` from `herdr-subagent`.
- Root `package.json` lists `herdr-subagent` and `herdr-bridge` as extensions and dependencies; `package.test.ts` asserts them.
- `scripts/test-policy.ts` names `herdr-subagent` slow tests; `scripts/test-policy.test.ts` and `scripts/test-affected.test.ts` use `herdr-subagent` paths as fixtures.

## 12. Tests

Deterministic (scripted tmux, temp store):

1. Existing catalog, validation, numbering, partial failure, ordering, timeout precedence, and truncation tests pass after the move.
2. Abort before child creation creates nothing. Abort after submission leaves the request on disk and the child running.
3. Concurrent `ensureLive` from two callers creates one session and one Pi process. Both may invoke `new-session`; the loser gets the duplicate-session error and returns the winner's nonce.
4. A stale `status.json` with an old nonce does not count as readiness.
5. Startup marks an old-nonce `running` result `interrupted` and does not re-dispatch it.
6. `busy` at two unsettled requests on a live child; a cancelled wait leaves the queued request in place. A stopped child with a stale `running` request and a queued one is resumed, the stale request becomes `interrupted`, and `ask` is admitted.
7. `retrieveResult` returns a settled result without launching; a pending result gets a fresh budget; `lost` requires two polls and reports `started` correctly.
8. Drain transitions: idle exits on `drain` appearing; busy exits after queued work; blocked stays; never exits at startup; inspection-only resume exits after detach or after 60 s unattached.
9. Reload never writes `drain`; quit, new, resume, and fork do.
10. Reports: delivered once per process; not redelivered when present in history; delivered after the parent restarts if absent.
11. Ownership: `ask` and `retrieveResult` against another parent's child are rejected.
12. Picker scope: ambiguous worktree errors; empty worktree shows an empty menu; children grouped by parent; grandchildren listed under their creating child.
13. Dispatch without an `input` confirmation settles `failed` / `error` and is not re-dispatched. A request entry missing from the branch at settlement yields `superseded`.
14. An unconfirmed in-flight report is resent after the parent is observed idle; a confirmed one is not.
15. Child `/reload` keeps the same nonce, and `status.json` stays valid for readiness.
16. Dispatch: `input` followed by no `agent_start` (consumed input, missing auth) settles `failed` / `error`; `input` with `streamingBehavior` is taken back and dispatched again when idle; a `/skill:` instruction is expanded and binds to its expanded entry.
17. Launch arguments: an allowlist gains exactly `subagent_report`, plus `subagent_ask` and `subagent_retrieve` for a depth-1 child that lists `subagent`; `projectTrust` produces `--approve` or `--no-approve`, and a cwd outside the parent's gets `--no-approve`.
18. Nesting: a depth-1 child registers the parent tools and creates `depth: 2` children with its worktree; a depth-2 child registers none; a depth-1 child exiting through drain drains its grandchildren.

Integration gates (disposable socket, real Pi): every **Verify** item, rendering and keys in the float, resume with the agent's model, tools, and prompt intact, operator input during a delegated request, dispatch with missing authentication and with an input handler that consumes the request, and a child started in a cwd with no recorded trust decision.

## 13. Delivery order

1. Create `tmux-subagent`, move `agents.ts`, `pi-session.ts`, and `subagent-tool.ts` with their tests. Repoint the `parseAgentFileContent` imports (§11).
2. Run the Verify integration probes for Pi session flags, `agent_settled` ordering, custom-message persistence, and nested-client keys. Revise this spec if any fail.
3. `store.ts`, `tmux.ts`, `launch.ts`, `child.ts`: initial delegation end to end.
4. `ask`, `retrieveResult`, and report delivery.
5. Lifecycle hooks and drain.
6. `cli.ts` and the installation snippet.
7. Cutover: switch package wiring, delete `herdr-subagent` and `herdr-bridge`, keep `herdr-contract`. Update the glossary's Herdr-specific terms and add an ADR superseding ADR-0004 (the workspace now owns child run state).

## 14. Decisions

- **Nesting:** one level (§8 Nesting), so that skills such as code review can delegate from inside a child. Deeper nesting is out of scope.
- **Answer after operator follow-up:** return the latest answer with `humanIntervened: true`, because an earlier answer may be stale. The step 2 probe confirms that `agent_settled` ordering supports this; it does not reopen the decision.
