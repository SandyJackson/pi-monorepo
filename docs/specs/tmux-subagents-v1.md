# Tmux subagents V1

Status: design consolidated from the operator interview; not implemented.
Target: Pi 1.3.0, tmux 3.8, macOS, Workmux session mode.

This document defines the agreed V1 workflow and proposes an implementation. It supersedes the target-design proposals in [the migration research](../research/herdr-to-tmux-subagent-migration.md), not the description of today's implementation in [subagents_structure.md](../reference/subagents_structure.md). Source changes require a separate implementation request.

The subsequent [pass-one API contract](tmux-subagents-v1-api.md) is authoritative for caller-facing operations, tool schemas, request/result vocabulary, persistence placement, queue admission, and timeout semantics. The [pass-two protocol contract](tmux-subagents-v1-protocol.md) refines record ownership, coordination, recovery, report delivery, draining, and inspection behavior.

## 1. Workflow and scope

Workmux owns the operator's worktrees and ordinary tmux sessions. Each worktree has its own session, usually with separate windows for Pi, Neovim, and other tools. Subagents must not add windows or sessions to that ordinary navigation.

V1 provides:

- Existing catalog-based, typed delegation, including parallel tasks and ordered results.
- Hidden interactive Pi children on one shared private tmux server, with one session per child.
- A tmux-level picker in a floating pane, scoped to the current worktree and grouped by parent Pi conversation.
- Interactive inspection floats. Dismissing an inspection view disconnects it without stopping the child.
- Parent-to-child follow-up turns that wait for an answer.
- An explicit child-to-parent reporting tool that queues a follow-up, never a steering message.
- Brief attention floats that do not take focus.
- Saved child conversations, resumed on demand after their processes exit.
- Clean-parent-exit and session-switch handling, without treating extension reloads as exits.

Workmux integration means cooperating with its session layout, not creating or deleting worktrees. V1 must not modify the operator's tmux configuration automatically.

Tmux is required. Herdr compatibility is optional, not a V1 acceptance condition. Preserve useful separation in the existing code, but do not build a second messaging implementation or a general runtime framework just to retain Herdr.

## 2. Terms and identities

A child conversation persists independently of its Pi process, tmux session, inspection view, and individual delegated turns. Keep those identities distinct:

- A stable **child ID** identifies the saved conversation across process restarts.
- A **parent session ID** identifies the owning Pi conversation, not a terminal pane or process.
- A **delegation ID** groups the initial batch and its optional purpose label.
- A **delegated task number** remains the one-based position within that delegation.
- A **request ID** identifies a particular initial or follow-up turn.
- A tmux address includes the server socket and session/pane identity. A bare pane ID is not globally unique.
- A Pi session ID and session-file path identify persisted history; an answer reference additionally identifies one exact entry.

The owning worktree is the parent's worktree when the child is created. Record the child's execution cwd separately: an explicit task cwd must not silently move the child into another picker's ownership group. Use canonical filesystem identity, not mutable Workmux session names, for grouping.

[The glossary](../../GLOSSARY.md) now distinguishes a **subagent inspection float** from a tmux popup. Its existing Herdr-specific "visible subagent" definition describes the old implementation and needs revision with the implementation cutover. Here, inspectability does not mean continuous visibility.

## 3. Tmux arrangement and inspection

### Private server

Use one machine-local private socket shared by all parents and worktrees. Start the server when the first child needs it. Each child occupies its own session, normally containing one Pi pane.

Use a controlled private-server configuration, rather than implicitly loading the user's full tmux configuration. Set policies explicitly:

- Detached children survive with no attached clients: `destroy-unattached off`, `exit-unattached off`.
- The server may exit when it has no sessions: `exit-empty on`.
- Normal child exit removes its session. Do not leave dead panes keeping an otherwise empty server alive indefinitely.

Crash-pane retention is optional. If introduced, it must have explicit cleanup and must not defeat normal empty-server shutdown. Pi transcripts and registry records survive server exit; tmux scrollback and layouts do not.

A private socket isolates navigation, not environment freshness. Pass the intended per-child environment explicitly at launch. Do not persist credentials in registry files. Launch the current Pi executable through argv, not shell-ready timing or `send-keys` command injection.

### Picker

Expose a command suitable for a user-installed tmux key binding. Supply a configuration snippet; do not select a shortcut or rewrite the user's config.

The command opens a picker float in the invoking Workmux window. Resolve its worktree from the invoking pane's cwd and repository metadata, not from a guessed parent Pi process. If resolution is ambiguous or fails, show an explicit error rather than listing unrelated children.

List current-worktree children grouped by parent, with enough information to distinguish parent conversations and children: stable IDs, agent, purpose, and running/stopped/blocked state. Include saved stopped children because selecting them resumes their conversations. Empty scopes show an empty-state message, not an unfiltered machine-wide list.

Selecting a child closes the picker and opens its inspection float. The implementation may use an existing terminal selector; V1 does not require a new general-purpose picker framework. Native `choose-tree` alone cannot enumerate children on another server.

### Inspection

The float on the ordinary server runs a tmux attachment client connected to the child's private-server session. It does not own the child Pi process. Clear outer `TMUX`/`TMUX_PANE` for this cross-server attachment and control attachment-time environment updates.

This is intentionally a nested tmux client. Native pane movement cannot transfer a pane between servers. Configure the private server and viewer bindings so ordinary Pi keys, especially Escape and Ctrl-C, reach Pi. Provide a tmux-level dismissal action; do not reserve those keys for automatic float destruction.

Dismissal closes only the attachment/viewer. An explicit Pi quit inside the child ends its process. Inspection and follow-up must never start a second Pi writer against an already-running child's session file. Serialize launch/resume per child across processes, including simultaneous picker and parent requests.

Use tmux 3.8 floating-pane commands, not `display-popup`. One window permits only one modal float, so close a modal picker before opening a modal inspection view. Exact dimensions and bindings are implementation details to validate with real Pi rendering.

## 4. Delegation and follow-ups

### Preserve the existing contract

Keep the existing tool's catalog listing, strict validation, agent discovery precedence, trusted project-agent gating, agent frontmatter settings, and sanitized task delivery. Preserve its model, thinking, tools, system prompt, cwd, and timeout behavior, including existing child restrictions such as disabling MCP where currently required.

Retain:

- At most eight tasks per initial delegation.
- Per-task validation failures without suppressing valid siblings.
- Sequential launches with concurrent observation, without a serial completion queue.
- Exactly one outcome per accepted task, presented in original request order.
- Timeout precedence: explicit call override, then agent default, then 60 minutes.
- Initial-delegation deadlines measured from confirmed launch, not time spent allocating placement. Follow-up and later retrieval budgets are defined in the [API contract](tmux-subagents-v1-api.md#6-timeouts-and-cancellation).
- Exact answer references, resolved to text only for presentation, with canonical truncation.

The optional delegation `label` becomes purpose metadata displayed in results and the picker. It no longer promises a physical tab containing the batch.

Results expose the stable child ID for future follow-ups, including timeout and observation-abort results when a child exists. Cancellation before launch creates no child; cancellation or timeout after launch stops observation only. Neither kills, interrupts, nor retracts already-submitted child work.

### Follow-up turns

A follow-up addresses one existing child ID, resumes it if stopped, submits one instruction, and retrieves its correlated result. Its retrieval budget starts at durable submission and includes queue time. Later `retrieveResult` calls get fresh waiting budgets and never resubmit work or launch Pi.

Do not steer an active child turn. Permit one pending parent follow-up behind active work; further submissions return `busy` without publication. Durable publication is the cancellation boundary: before publication, cancellation can prevent work; afterward it ends retrieval only. Ambiguous publication returns the request reference without claiming a safe retry. See the [API contract](tmux-subagents-v1-api.md) for the agreed result distinctions.

Reuse the agent configuration captured for that child, subject to current trust and permission checks. Resume must not silently broaden tools or approvals. Inspection alone resumes Pi without submitting a task. A missing transcript or removed cwd produces an actionable failure, not a fresh conversation disguised as the old child.

The agreed tools are `subagent`, `subagent_ask`, `subagent_retrieve`, and child-only `subagent_report`. Follow-ups address one child per call. Strict schemas, reporting guidance, and runtime operations are specified in the [API contract](tmux-subagents-v1-api.md#7-model-facing-tools).

### Exact answers and direct human input

The operator may type directly into an inspected child, including while a parent is waiting. Do not disable that interaction.

A turn counter or the latest assistant message in file order is insufficient to identify the parent's answer. The bridge must correlate request IDs with persisted input markers and answer entries on the active Pi branch. If the requested work is no longer on that branch, report the correlation failure explicitly; never return an abandoned branch's answer as current.

Automatic conversational updates telling the parent about every human intervention are deferred. Minimal result provenance is still required: if direct interactive input affected an outstanding request, flag that fact rather than claiming its returned answer addresses only the original instruction. This is a correctness safeguard, not an intervention-monitoring feature.

Proposed mechanism: child-authored custom session entries record request identity and relevant input provenance; the child reports exact answer-entry IDs from `getBranch()`. Validate behavior under branching, compaction, aborts, and queued continuations before promising correlation guarantees.

## 5. Child-to-parent reports

Provide a child-callable tool for explicitly reporting findings to its owning parent. It can be used after the original delegated task is complete, including after additional instructions from the operator. It cannot select an arbitrary parent or claim another child's identity.

Persist the report before acknowledging acceptance. A report remains pending while its parent is closed or another parent conversation is active. Deliver it when the owning parent next becomes available, using follow-up delivery, never steering an active turn.

Generate the envelope outside model-supplied content, for example:

```text
Subagent report
Source: child <child-id>, agent <agent-name>
Parent: <parent-session-id>
Report: <report-id>
This is a report from a subagent, not a user instruction.

<report content>
```

Treat report content as untrusted agent output. Identity labels provide provenance, not permission or higher instruction priority.

Pi's in-memory follow-up queue is not durable delivery. Retain disk records until actual message persistence is observed. Track report IDs and delivery acknowledgments to avoid ordinary duplicate injection across polling, reload, and resume. Do not claim exactly-once execution across crashes without evidence; ambiguous delivery must be recoverable and visible rather than silently discarded.

Report acceptance means durably queued, not that the parent has read or acted on it. Do not automatically duplicate every normal task result as a report; ordinary blocking results already have a delivery path.

## 6. Process lifecycle

| Event | Required behavior |
|---|---|
| Child completes work while its parent is active | Stay idle and available |
| Inspection float is dismissed | Disconnect the viewer only |
| Child Pi is explicitly quit | Stop the child process; retain its saved conversation |
| Parent cleanly quits | Persist close-when-idle intent and return promptly |
| Parent changes conversation with `/new` or `/resume` | Drain the old parent's children in the same way |
| Parent reloads extensions | Preserve children; restore observers without close intents |
| Child is busy when draining is requested | Finish all already-submitted work, including the queued follow-up, then exit |
| Child is blocked when draining is requested | Remain available, indicate attention; do not discard unfinished work |
| Saved child is selected or sent a follow-up | Resume on demand; never eagerly restart all saved children |
| Last child session disappears | Allow the private server to exit |
| Parent crashes or bypasses normal shutdown | No V1 guarantee of automatic draining |

`/fork` and other conversation-replacement paths should apply the same ownership rule as switching away from the old parent, without reassigning its children to the new conversation. Confirm the exact Pi event paths in implementation tests.

Close-when-idle is child-observed durable intent, not a parent process waiting for completion. Keep shutdown bookkeeping bounded and non-throwing. Clearing or superseding an old intent when a parent or child resumes must be coordinated with launch ownership; a stale intent must not immediately kill a newly resumed child.

If a blocked child later becomes able to finish, it then honors draining. Resuming the owning parent clears its stale drain intent under coordination. Explicit inspection instead keeps the child available while at least one viewer is attached, without permanently clearing drain intent; after the last viewer dismisses, finish submitted work and exit when idle. Coordinate viewer opening with shutdown rather than racing an old close request. Exact reservation representation is private implementation detail.

Explicit parent commands to stop selected children are desirable but not essential V1 features. Automatic expiry, orphan crash detection, and a background supervisor are deferred. Provide operational cleanup instructions; never remove transcripts as a side effect of stopping tmux.

## 7. Attention notices

V1 uses brief non-focus-stealing tmux attention floats, not macOS notifications. Trigger them for blocked children and unexpected child failures. Routine successful task completion does not need another alert.

Show the child identity and a short reason, with no automatic attachment, terminal preview, or keyboard-focus change. Expire the notice automatically. Coalesce repeated notices for unchanged conditions rather than creating a stream of floats.

Target an appropriate window in the owning worktree's ordinary tmux session. Floats belong to windows, not individual clients. Record enough outer-server context to route them without guessing or presenting another worktree's child as local. If no suitable client/window is available, retain attention state for the picker; do not require a permanent notification daemon or resurrect the parent just to display a notice.

A child that remains blocked after parent shutdown must be able to record that attention state independently. Actual display is best-effort, while blocked state remains visible on subsequent inspection. Exact duration, placement, and suppression while another modal float is open require integration testing.

A persistent status-line indicator and OS notifications are possible later additions, not V1 requirements. The Pi notification example emits terminal escape sequences and is not sufficient for unattended children on a detached private server.

## 8. State ownership and implementation proposal

Runtime state belongs outside source-controlled worktrees under `~/.pi/agent/subagents/`. The agreed initial layout puts one `metadata.json` per child beside its `session/` data, with `requests/<requestId>/request.json` and `result.json` below the same child directory. Store worktree identity, parent identity, child identity, and execution cwd separately. See the [API contract](tmux-subagents-v1-api.md#8-durable-placement-and-lookup); live tmux state should be discovered and validated rather than unnecessarily mirrored.

Persist only what is needed to reconstruct ownership and resume:

- Child ID, agent configuration, purpose/delegation metadata, owning worktree and parent.
- Pi session identity/path and execution cwd.
- Current process incarnation, tmux addresses, state, and close intent.
- Requests, exact answer references, reports, and delivery acknowledgments.

Use private directories/files, atomic replacement for snapshots, unique message IDs, and single-writer or locking rules for mutable records. Do not let parent and child overwrite each other's state snapshots. Treat registry paths, socket addresses, tmux targets, and user-provided text as untrusted inputs when constructing commands.

A minimal proposed division of responsibility is:

- Existing catalog and tool presentation remain largely unchanged.
- A neutral delegation contract replaces imports from `herdr/*`.
- A tmux runtime module owns launch/resume, registry reconciliation, and ordered observation.
- A child bridge owns session-state reporting, inbox consumption, branch-aware answer references, and draining.
- A small inspection command owns picker and float attachment.

Keep the injected delegation operation as the tool seam. Use a scripted tmux-call adapter and filesystem fixtures for tests; do not introduce a generic scheduler or runtime class hierarchy. Exact filenames and package renaming are implementation proposals, not approved abstractions.

### Outcomes and state

Keep the existing terminal outcome meanings: `completed`, `timed_out`, `aborted`, `session_closed`, `launch_failed`, `launch_indeterminate`, and `observation_failed`, plus tool-level `invalid` validation results.

`blocked` is a live child state, not automatically a terminal task outcome. The wait remains active until completion, timeout, cancellation, or a genuine failure. Keep the existing `herdr:blocked` event contract as input to the new bridge; renaming it is unnecessary V1 churn.

For tmux, `launch_indeterminate` means creation may have succeeded but a trustworthy child startup acknowledgment was not obtained. Include the stable child ID and any known tmux address, and reconcile before retrying rather than spawning duplicates. Missing state is not proof that no child exists.

Answer selection superseded by direct `/tree` changes produces the `answer_superseded` request result defined in the API contract, not false completion. The initial-tool mapping must preserve that distinction and its total ordered outcome contract; see the pass-two audit.

## 9. Deferred work

- All-worktree picker view.
- macOS notifications and terminal escape-protocol relays.
- Persistent status indicators.
- Automatic parent updates for every direct human intervention.
- Full stop/manage/GC tool suite and configurable retention policy.
- Parent crash detection, automatic orphan expiry, and a supervisor daemon.
- Per-task worktree creation, Workmux lifecycle hooks, and worktree removal automation.
- Steering tools, chain workflows, broader concurrency changes, and a new general-purpose TUI.
- Required Herdr parity for the new communication tools.

## 10. Verification and acceptance

### Deterministic tests

Exercise existing behavior through the delegation/tool seam and new private filesystem/tmux seams:

1. Catalog, trust gating, strict validation, task numbering, partial failure, ordered fan-out, timeout precedence, exact references, and truncation remain correct.
2. Cancelling observation and timing out never terminate a child. Cancellation before submission cannot enqueue unexpected later work.
3. Concurrent launch/resume/inspection requests cannot create two Pi writers for one saved child.
4. Startup idle or stale state cannot count as completion of a new request. Branching and direct input cannot silently substitute another answer.
5. Parent quit and conversation replacement drain correctly; reload never writes a close intent. Shutdown returns without waiting for child work.
6. Pending reports survive parent closure, reload, and resume and reach only the owning parent with a generated provenance envelope.
7. Picker scope remains current-worktree, grouped by parent; empty scope never falls back to unrelated children.
8. Missing transcripts, removed cwds, dead sockets, ambiguous starts, explicit child exit, and stale process records fail honestly without destructive recovery.
9. Repeated attention events are coalesced; attention handling never changes input focus or kills an inspected child.

### Integration gates

Prior research exercised isolated tmux 3.8 servers with shell children, including cross-server float attachment, viewer destruction, reattachment, passive floats, explicit launch environment, and empty-server lifecycle. This is evidence for tmux mechanics, not an end-to-end Pi/Workmux pass.

Before shipping, verify actual Pi and Ghostty/Workmux behavior:

- Interactive rendering, resizing, Unicode, Escape, Ctrl-C, tmux prefix routing, and viewer dismissal.
- Picker-to-inspector handoff, simultaneous viewers, zoomed windows, and passive-notice expiry.
- Pi clean shutdown/reload/switch events and child drain behavior with queued work or blocked tools.
- Resume with agent prompt, model/tools/trust constraints, stable identity, and no unintended new task.
- Durable report delivery and correlation with real Pi session entries, including ambiguous delivery recovery.
- Private-server isolation from user configuration and stale environment, normal empty shutdown, and reliable restart.

Use disposable sockets and session fixtures. Do not run experiments against the operator's live sessions without consent. Follow repository checks: `pnpm lint`, `pnpm typecheck`, relevant tests, then `pnpm check:affected` before declaring an implementation ready.

## 11. Delivery sequence

1. Extract neutral contracts and preserve existing tests; establish the tmux-call seam and runtime-owned state.
2. Implement launch, child reporting, ordered observation, exact branch-aware answers, and cancellation parity.
3. Add durable follow-up/report transport and on-demand single-writer resume.
4. Add tmux picker/inspection floats and attention floats, then clean parent lifecycle handling.
5. Validate real Pi/Workmux interaction, finalize installation snippet and recovery instructions, then cut over package wiring and documentation.

These are implementation slices, not independently reduced definitions of V1. If lifecycle or communication work is split into later changes, the delivered scope must be stated explicitly rather than called complete V1.

At cutover, revise the glossary's Herdr-specific definitions and record a successor to [ADR-0004](../adr/0004-keep-herdr-agent-state-managed-by-herdr.md): the workspace now owns child run state. Preserve [ADR-0006](../adr/0006-share-the-authored-herdr-event-contract.md)'s stable event contract. Do not mark the old implementation ADR superseded merely because this unimplemented spec exists.

## 12. References and research corrections

- [Initial migration research](../research/herdr-to-tmux-subagent-migration.md) and [implemented architecture](../reference/subagents_structure.md).
- [Official Pi subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent): useful typed dispatch and reporting reference, but its non-interactive subprocess lifetime is not this design.
- [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent): persistent registry/inbox reference. Research found no license; do not copy its code without resolving licensing.
- [mitsuhiko subagent extension](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/subagent.ts): private-server/tool reference, but not its exit-after-task behavior or shell injection launch.
- [tmux 3.8 manual](https://github.com/tmux/tmux/blob/3.8/tmux.1), [floating-pane implementation](https://github.com/tmux/tmux/blob/3.8/cmd-split-window.c), and [3.8 release discussion](https://github.com/tmux/tmux/issues/5584).
- [Workmux session-mode documentation](https://github.com/raine/workmux/blob/main/docs/src/content/docs/guide/session-mode.md).
- [Pi notification example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/notify.ts).
- Pi lifecycle, session, and messaging feasibility was checked against the installed `@earendil-works/pi-coding-agent@1.3.0` docs and distribution types/source. Actual integration remains gated above.

Corrections to the initial research: a shared private server can inherit stale environment; tmux floats and popups are distinct; each child gets a session rather than a pane in a delegation tab; process lifetime is shorter than conversation lifetime; branch/request correlation cannot rely on settled-turn counts; blocked state need not become a terminal outcome; detached children cannot rely on the terminal notification example for delivery. Do not claim exactly-once message processing merely because writes are atomic or session markers exist.
