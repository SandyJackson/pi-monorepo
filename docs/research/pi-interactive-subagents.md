# pi-interactive-subagents communication and persistence

## Scope

This note examines [`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents) at commit [`c100577`](https://github.com/HazAT/pi-interactive-subagents/tree/c100577ebf7393a11d098ad9810ec6c269dcfc30), tagged `v3.7.2`. It focuses on communication between parent and child agents, completion detection, session persistence, and ideas relevant to this repository's Herdr subagent implementation.

## Summary

`pi-interactive-subagents` runs each child in a visible cmux, tmux, zellij, or WezTerm pane. The parent tool returns immediately and keeps an in-process background watcher for each child. Communication uses files and terminal output rather than an inter-process message channel:

1. The parent sends the task through Pi command-line arguments or an artifact file.
2. A child-only Pi extension records lifecycle activity in an atomic JSON snapshot.
3. Explicit completion and help requests use a `<session>.exit` JSON sidecar.
4. Process exit is detected through a shell sentinel printed in the terminal.
5. The child Pi session JSONL supplies the final answer and later resume state.
6. The parent extension injects the result into its own Pi session with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`.

The system is asynchronous from the model's perspective, but it still polls internally. The parent extension checks child files and terminal output every second. Its main improvement is not the absence of polling. It separates completion, liveness, and answer extraction into different signals.

## Launch and parent-to-child communication

The parent creates a deterministic child session path, starts a multiplexer surface, and runs Pi with a child-only extension. It passes identity and artifact paths through environment variables such as `PI_SUBAGENT_ID`, `PI_SUBAGENT_SESSION`, and `PI_SUBAGENT_ACTIVITY_FILE`. See [`launchSubagent`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/index.ts#L933-L1221).

Tasks use one of two delivery methods:

- Full-context forks receive a direct positional prompt.
- Blank or lineage-only sessions receive an `@artifact` path containing the role wrapper and task.

Long shell commands are written to scripts before being sent to the pane, avoiding command corruption from terminal wrapping. Multiplexer-specific process control is concentrated in [`cmux.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/cmux.ts).

The public `subagent` tool is deliberately fire-and-forget. It returns a `started` acknowledgement while `watchSubagent` continues inside the parent extension. See the tool registration and steer delivery in [`index.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/index.ts#L1380-L1545).

## Child-to-parent communication

### Activity snapshots

The child-only extension subscribes to Pi lifecycle events including `before_agent_start`, `agent_start`, provider activity, streaming updates, tool execution, and `agent_end`. It reduces those events to a small state record with:

- a random `runningChildId` supplied by the parent;
- a monotonic sequence number;
- timestamps;
- `starting`, `active`, `waiting`, or `done` phase;
- the current activity scope, such as provider, streaming, or tool.

The child writes this record using a temporary file plus atomic rename. Streaming updates are throttled to 500 ms. See [`activity.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/activity.ts) and the event wiring in [`subagent-done.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/subagent-done.ts#L130-L245).

The parent reads the snapshot every second and rejects stale files whose `runningChildId` does not match the current launch. Sequence and timestamp checks reject older observations. Missing, invalid, or mismatched snapshots become `stalled` after 60 seconds. See [`status.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/status.ts) and [`observeRunningSubagent`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/index.ts#L717-L747).

This is a useful correlation mechanism. A state from an earlier child cannot complete or describe the current child merely because it occupies the same pane or file location.

### Explicit completion and help requests

The child extension exposes two tools:

- `subagent_done` writes `{ "type": "done" }` to `<session>.exit`, then requests graceful shutdown.
- `caller_ping` writes a structured help request to the same sidecar, then shuts down so the parent can respond by resuming the session.

The auto-exit error path writes an error sidecar containing the provider or agent error. See [`subagent-done.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/subagent-done.ts#L165-L316).

The parent watcher checks this sidecar first. If the child exits without writing one, the shell command prints `__SUBAGENT_DONE_<exit code>__` and the watcher finds it by reading the pane's terminal. This sentinel is the crash and ordinary process-exit fallback. See [`pollForExit`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/cmux.ts#L1229-L1339).

### Result delivery

Completion status does not carry the answer. Once the watcher has an explicit completion or process-exit signal, it reads the child session JSONL and extracts the last assistant message. It then closes the surface and injects a `subagent_result` or `subagent_ping` custom message into the parent Pi session. See [`watchSubagent`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/index.ts#L1246-L1351) and [`findLastAssistantMessage`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/session.ts#L79-L117).

This division is sound:

- activity snapshots describe liveness;
- sidecars and shell exit describe completion;
- session JSONL contains transcript and answer data.

The implementation never treats session-file growth as proof of activity or completion.

## What its persistence means

The project has durable child sessions, but not a durable running-task registry.

### Durable session files

Every Pi child has a deterministic JSONL path. The `session-mode` setting controls how it begins:

- `standalone`: a fresh unrelated session;
- `lineage-only`: a blank child session whose header points to `parentSession`;
- `fork`: a child session seeded with the parent's previous conversation entries.

The seeding logic writes a Pi v3 session header and optionally copies parent entries. See [`seedSubagentSessionFile`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/session.ts#L41-L70).

### Resume and follow-up turns

`subagent_resume` launches Pi against an existing child session in a new pane. It records the entry count before launch and reports only entries appended by the resumed turn. See the [`subagent_resume` tool](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/index.ts#L1710-L1968).

`caller_ping` builds a parent-child exchange on top of this:

1. The child writes a help request and exits.
2. The parent receives a steer message containing the session path.
3. The parent calls `subagent_resume` with guidance.
4. Pi continues from the same JSONL transcript in a new pane.

This is persistence of conversation and lineage. It is not persistence of the live process or pane.

### Non-durable running state

Running children live in an in-memory `Map`. Parent shutdown aborts watchers and clears the map. A parent crash cannot reconstruct which children were active, and orphaned panes are not adopted on restart. See [`runningSubagents`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/index.ts#L519-L533) and session shutdown handling in [`index.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/index.ts#L1360-L1385).

## Comparison with this repository

| Concern | pi-interactive-subagents | Current Herdr module |
|---|---|---|
| Parent tool lifetime | Returns immediately | Waits for delegated outcomes |
| Child visibility | Mux pane | Herdr pane |
| Lifecycle source | Child Pi hooks written to JSON snapshots | Child Pi hooks projected into Herdr state |
| Parent observation | Polls snapshots, sidecars, and terminal every second | Polls `agent.get` every 800 ms |
| Completion correlation | Explicit sidecar or process sentinel, with per-launch child ID for status | Pane status plus observed activity |
| Answer transport | Reads latest assistant message from JSONL after completion | Stores exact `{path, entryId}` and resolves it during presentation |
| Live process after completion | Usually exits and pane is closed | Pane and Pi session remain live |
| Conversation persistence | Session path, lineage/fork modes, explicit resume tool | Session path captured in outcome, but no follow-up tool |
| Running registry persistence | In-memory only | In-memory operation only |

The other project does not solve the stale `done` problem by accepting `done`. It avoids using status as completion. Completion comes from a signal generated by the current child, while the random child ID prevents old activity snapshots from being mistaken for the current launch.

## Ideas worth borrowing

### 1. Keep completion separate from answer extraction

This is the strongest idea. A lifecycle signal should say that the delegated turn completed. JSONL should only provide the persisted answer. This repository already follows that division conceptually, but Herdr's pane status lacks explicit delegated-turn correlation.

The preferred improvement is to obtain correlation from Herdr, for example through atomic `agent.prompt` with `wait` or a pane-status subscription established before prompt submission. A new child sidecar extension should be a fallback because issue #1 deliberately retained Herdr's managed state projection instead of adding another child hook bridge.

### 2. Add first-class follow-up and resume

The exact Pi session path already exists in `VisibleSubagentSessionRef`. A future tool could send another turn to the still-live Herdr pane or reopen the session by path if the pane is gone. This would make the distinction between delegated task and persistent visible session useful to callers rather than only descriptive.

### 3. Record parent-child lineage

A `parentSession` link or explicit fork mode could make child sessions easier to discover and understand later. This requires deliberate context policy. Copying the parent's conversation can increase token use and leak context a specialized child does not need, while lineage-only provides discoverability without inheritance.

### 4. Consider asynchronous result steering separately

Returning immediately and steering results back lets the parent continue other work. It also changes ordering and conversation semantics: results may interrupt unrelated work, multiple children can steer in completion order, and the parent extension must survive after the tool call returns.

This is a product decision, not a transport improvement. The current ordered blocking delegation provides simpler deterministic results. If asynchronous delegation is added, it should be a distinct operation rather than silently changing the existing tool contract.

## Ideas not worth copying directly

- Do not add a general multiplexer adapter. Herdr is the one concrete runtime and already owns pane control.
- Do not use terminal screen scraping when Herdr has structured socket methods and events.
- Do not infer lifecycle from JSONL growth.
- Do not add child-written snapshots merely to duplicate Herdr's managed Pi hook projection.
- Do not call the design durable orchestration unless the running registry can be reconstructed after parent restart.

## Conclusion

`pi-interactive-subagents` is most interesting for its explicit separation of liveness, completion, answer data, and session history. Its persistence is primarily Pi session persistence plus an explicit resume operation. The implementation still polls and relies on filesystem sidecars and terminal sentinels because its multiplexers do not supply a shared lifecycle protocol.

For the Herdr module, the best transferable changes are a task-correlated completion signal and a first-class follow-up or resume operation. Herdr's event-driven socket methods should supply the former before introducing another child extension or filesystem protocol.

## Final Agent message:

I inspected `pi-interactive-subagents` v3.7.2 at commit [`c100577`](https://github.com/HazAT/pi-interactive-subagents/tree/c100577ebf7393a11d098ad9810ec6c269dcfc30).

## How agents communicate

It does not have a direct parent-child message channel. Communication uses several filesystem and terminal mechanisms:

1. **Parent to child**
   - The task is passed as a Pi argument or through an `@artifact` file.
   - Environment variables provide a random child ID, session path, activity-file path, and agent identity.
   - See [`launchSubagent`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/index.ts#L933-L1221).

2. **Child lifecycle**
   - A child-only Pi extension listens to events such as `agent_start`, provider activity, streaming, tools, and `agent_end`.
   - It writes a small atomic JSON activity snapshot containing the child ID, sequence number, timestamps, and phase.
   - The parent reads this once per second.
   - See [`activity.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/activity.ts).

3. **Completion**
   - `subagent_done` writes `<session>.exit` with `{type:"done"}`.
   - `caller_ping` writes a structured help request to the same sidecar.
   - Auto-exit errors write an error sidecar.
   - See [`subagent-done.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/subagent-done.ts#L165-L316).

4. **Crash and process-exit fallback**
   - The launch script prints `__SUBAGENT_DONE_<exit code>__`.
   - The parent polls the terminal screen for this sentinel.
   - See [`pollForExit`](https://github.com/HazAT/pi-interactive-subagents/blob/v3.7.2/pi-extension/subagents/cmux.ts#L1229-L1339).

5. **Answer transfer**
   - Completion signals do not contain the answer.
   - After completion, the parent reads the child JSONL and extracts the last assistant message.

6. **Waking the parent**
   - The watcher calls `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`.
   - This makes the tool appear asynchronous to the model. The original `subagent` call returns immediately.

Despite the README describing it as fully non-blocking, it still polls internally every second. The model does not poll, but the extension does.

## The interesting persistence

Its persistence is primarily Pi session persistence:

- `standalone` creates an unrelated session.
- `lineage-only` creates a blank session with `parentSession` linkage.
- `fork` copies prior parent conversation entries into the child.
- `subagent_resume` starts Pi against an existing child JSONL in a new pane.
- It records the existing entry count and returns only messages added by the resumed turn.

`caller_ping` builds a useful protocol on top:

1. Child writes a help request and exits.
2. Parent receives the request with the session path.
3. Parent resumes that session with guidance.
4. The child continues from its existing transcript.

There is an important limitation: the live task registry is only an in-memory `Map`. Parent restart or crash loses the registry and watchers. This is durable conversation history, not durable orchestration.

## Relevance to our `done` problem

Their design supports your concern about accepting first-poll `done`.

They do not use status as proof of completion. Status only drives the widget and stall supervision. Completion must come from a signal produced by the current child.

The activity snapshot also contains a random `runningChildId`. A stale snapshot from an earlier child is explicitly rejected. That is the correlation missing from our current Herdr status polling.

## What I would borrow

1. **Keep status, completion, and answer extraction separate.** This is their strongest design decision.
2. **Add a first-class follow-up or resume operation.** We already retain the child session path and live pane, but expose no convenient way to continue it.
3. **Consider lineage-only sessions.** A `parentSession` link gives discoverability without copying the parent’s entire context.
4. **Consider asynchronous result steering as a separate mode.** It is useful, but completion-order messages can interrupt unrelated parent work, so it should not silently replace ordered blocking delegation.

## What I would not borrow

- Filesystem sidecars and terminal screen scraping. Herdr already has structured socket events.
- Their large general-purpose multiplexer adapter. Herdr is our concrete runtime.
- Another child activity-snapshot extension unless Herdr cannot provide task-correlated lifecycle events.
- Claims of persistent execution without a reconstructable on-disk registry.

## Recommendation

The Herdr-native equivalent should be:

1. Use `agent.prompt` with its atomic `wait`, or subscribe before submission to `pane.agent_status_changed`.
2. Treat that correlated lifecycle result as completion.
3. Read the exact answer entry from JSONL afterward.
4. Add a later `subagent_continue` or `subagent_resume` tool using the existing pane and session path.

That takes the good part of their design without copying the filesystem and screen-scraping machinery.

I recorded the detailed research at [`docs/research/pi-interactive-subagents.md`](docs/research/pi-interactive-subagents.md). It is currently uncommitted.
