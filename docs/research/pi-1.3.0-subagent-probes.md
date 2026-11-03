# Pi 1.3.0 behaviour probes for tmux subagents

**Status**: spike complete (ticket 2, issue #58, parent #56). No source changes.
**Date**: 2026-10-27. **Pi**: `@earendil-works/pi-coding-agent@1.3.0`, the workspace's pinned copy.
**Spec**: [`docs/specs/tmux-subagents.md`](../specs/tmux-subagents.md).

Each probe from #58 is recorded as **holds** or **fails** with the evidence. Source references are relative to `node_modules/@earendil-works/pi-coding-agent/dist/`.

## Summary

| # | Behaviour | Result |
|---|---|---|
| 1 | `--session-dir` + `--session-id` create, then resume the same file | holds, if the cwd is the same |
| 2 | `agent_settled` once per run, after queued follow-ups; `aborted` set by Escape; `agent_before_settle` outcome | **fails in part**: no `agent_before_settle` on an Escape abort |
| 3 | `sendUserMessage` follow-up: `input` + `agent_start` idle; `streamingBehavior` while streaming; no `agent_start` when consumed or unauthenticated | holds |
| 4 | Persisted user entry text equals the instruction | holds |
| 5 | `getLeafId()` at dispatch and `getBranch()` at settlement locate the request; absent after a `/tree` move | holds |
| 6 | `sendMessage` custom follow-up with `triggerTurn` gives `message_end` and a persisted `custom_message`, idle and queued | holds |
| 7 | `/reload` during a run | answered: not possible; idle reload gives `session_start` reason `reload` |
| 8 | `ctx.shutdown()` emits `session_shutdown` reason `quit` | holds |
| 9 | `--approve` / `--no-approve` skip the trust prompt | holds |
| 10 | Allowlist naming `subagent_report` enables it; unknown names ignored | holds |

## Method

All probes ran the pinned Pi in a disposable tmux server (`tmux -L spike02 -f /dev/null`) with:

- `PI_CODING_AGENT_DIR` set to a throwaway agent directory, so the operator's `~/.pi/agent` (settings, `trust.json`, auth, sessions) was never read for credentials or written. Afterwards no file in `~/.pi/agent` was newer than the probe files.
- `--session-dir` pointing at throwaway directories, `--no-mcp`, `PI_OFFLINE=1`.
- A throwaway extension, loaded with `--extension`, that logged every relevant event as JSONL and registered probe commands (`/p-send [ms] text` calls `pi.sendUserMessage(text, { deliverAs: "followUp" })` from a timer, plus `/p-custom`, `/p-branch`, `/p-tree`, `/p-consume`, `/p-reload`, `/p-shutdown`, `/p-tools`) and a no-op `subagent_report` tool.
- A local mock OpenAI-compatible endpoint registered as a `models.json` provider. It echoes the last user text. Text containing `SLOW` streams for about 8 s, and `FAIL` returns HTTP 400. So probes 2, 3 and 9 used real model requests through Pi's provider path without any real credentials. Missing authentication used a second provider whose `apiKey` is an unset environment variable.

Probes 1 to 8 ran `dist/cli.js`. Probes 9, 10 and the Escape-with-queued-request check ran `dist/bundle/cli.js`, the package `bin`. The harness was disposable and is not committed.

## Results

### 1. Session flags: holds, with a cwd condition

First launch with `--session-dir D --session-id scout-7k2q` reported `sessionId: "scout-7k2q"` and a file `D/<timestamp>_scout-7k2q.jsonl`. Pi writes the file at the first user or assistant message, not at startup (`core/session-manager.js:794-814`, `_persist` opens with `wx` once `_hasConversation()` is true). A second launch with the same flags and cwd reported the same file, `entries: 5`, and the transcript showed the first exchange.

The condition is the cwd. With an explicit `--session-dir`, `SessionManager.findById` only matches a session whose header `cwd` resolves to the current cwd (`core/session-manager.js:1421-1442`, `sessionCwdMatches` at `:441`). A third launch with the same flags from a different directory started an empty session with the same ID. `main.js:344-351` creates it after the warning `No project session found with id ...`, and that message is not visible in the TUI. Once that session gets a message, the directory holds two files with the same session ID.

A related tmux fact: `new-session -c <dir>` with a directory that does not exist starts the pane in `$HOME` without an error. Pi then records `$HOME` as the session cwd.

The spec already launches with `-c <child.json cwd>` on both first launch and resume, so this holds. It is fragile if the stored cwd is ever not exactly the launch cwd, or if the directory is gone.

### 2. Settlement events: fails in part

- **Once per run, after queued follow-ups: holds.** One run held the dispatched `SLOW request three`, an extension follow-up queued during it, and an operator `Alt+Enter` follow-up. The log shows one `agent_start`, all three user/assistant pairs, then one `agent_before_settle` (`completed`) and one `agent_settled` (`aborted: false`, `isIdle: true`). The queued extension request had no `agent_start` or `agent_settled` of its own.
- **`aborted` set by Escape: holds.** Escape during a streaming run produced `agent_end` then `agent_settled` with `aborted: true`.
- **`agent_before_settle` outcome: fails for aborts.** `completed` and `error` (HTTP 400 from the mock) were observed. On Escape, `agent_before_settle` did not fire at all. `AgentSession.abort()` sets `_agentRunAbortRequested` (`core/agent-session.js:1942-1944`), and the run loop skips the boundary when that flag is set (`:1426`): `if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;`. The `aborted` outcome is only reported when an assistant message ends with `stopReason: "aborted"` without `abort()`, which Escape does not produce.

Two consequences for the bridge. A handler that stores the outcome keeps a stale value from the previous run unless it resets it. The `aborted` flag on `agent_settled` is the only reliable abort signal. The spec's settlement table already checks `aborted` before the outcome, so only the recording rule needs to change. Also, `agent_before_settle` can fire more than once in one run when a handler requests continuation (`:1426-1431`), so the last value before `agent_settled` is the one to use.

Escape also returns queued follow-ups to the editor, including an extension `sendUserMessage` follow-up. The probe queued `queued-ext request then escape` (confirmed by `input` with `streamingBehavior: "followUp"`), pressed Escape, and the text ended up in the operator's editor. It never ran, and the run settled with `aborted: true`. Under the spec that request is recorded `failed` / `interrupted`. That is accurate enough, though the text may then sit in the editor for the operator to submit by hand.

### 3. `sendUserMessage(text, { deliverAs: "followUp" })`: holds

- **Idle:** `input` with `source: "extension"` and no `streamingBehavior`, then `agent_start` 2 to 3 ms later.
- **Streaming:** `input` with `source: "extension"`, `streamingBehavior: "followUp"`, no new `agent_start`. The request then ran in the same run.
- **Consumed:** with an input handler returning `{ action: "handled" }`, `input` was logged and nothing followed: no `agent_start`, no user entry.
- **Missing authentication:** `input` was logged, then no `agent_start`. The TUI showed `Extension "<runtime>" error: No API key found for nokey.` The error goes to the extension error channel, not to the caller. `prompt()` runs input handlers (`core/agent-session.js:1623`) before the auth check (`:1653-1663`) and only then `_startRun`.

`sendUserMessage` defaults `expandPromptTemplates` to `false` (`:1904`). A leading `/` is therefore not run as a command or expanded as a template.

`prompt()` and `sendCustomMessage()` called while `agent_settled` handlers run are deferred until those handlers finish (`:1603-1605`, `:1837-1839`). Dispatching from inside the bridge's `agent_settled` handler therefore works, but the `input` event comes after the handler returns.

### 4. Persisted user text: holds

The instruction `"/p-tools  leading slash\n\n  indented line\t \ntrailing  \n"` (leading slash, doubled spaces, tabs, trailing whitespace and newline) appeared byte-identical in the `input` event, the user `message_end`, and the persisted `message` entry. A typed command argument with internal double spaces was also preserved.

This depends on the child's extension set. An `input` handler that returns `transform` would change the text. In this repo the only `input` handler is `packages/herdr-subagent/index.ts:25`, which only acts on `source: "interactive"` and is removed at cutover. Pi's built-in extensions (`extensions/codemode`, `llama`, `mcp`, `tool-search`) register none.

### 5. Dispatch leaf and branch: holds

Dispatch leaf `b008f344`. At `agent_settled` the branch contained, after `b008f344`, the user entry `tree request alpha` and its answer. A `system` message entry can sit between the dispatch leaf and the user entry on the first run of a session, so "first user entry after the dispatch point" matters. Requests queued during a run record the dispatch leaf as the current run's user entry (`baf80cbf`), and the queued request's entry still follows it on the branch.

After `ctx.navigateTree("b008f344")` the branch no longer contained `tree request alpha`. `navigateTree` refuses while streaming (`core/agent-session.js:3232-3235`). Typing `/tree` during a run opened the selector, but navigation took effect only after the run settled. A `/tree` move therefore cannot remove a request entry between dispatch and the same run's `agent_settled`, except in the queued case before the run reaches it.

### 6. Custom message delivery: holds

- **Idle, `triggerTurn: true`:** `agent_start`, then `message_end` with `role: "custom"`, `customType: "subagent_report"`, then the assistant reply. No `input` event: custom messages do not pass through input handlers.
- **Queued during a run:** after the run's assistant reply, `message_end` for the custom message, then a further assistant reply, all in one run.

In both cases the session file holds a `custom_message` entry with `customType: "subagent_report"` and the `details` passed in. In the agent-loop path, `message_end` reaches extensions before persistence: at the custom `message_end` the last entry was still the previous `message`, and the `custom_message` entry appeared by the next event (`core/agent-session.js:752-768`). In the idle path without `triggerTurn`, `_appendCustomMessage` persists first, then emits (`:1854-1859`).

### 7. `/reload` during a run: not possible

Typing `/reload` while streaming showed `Warning: Wait for the current response to finish before reloading.` and nothing reloaded. `ctx.reload()` called from an extension command context during a run returned without throwing and did nothing (log: `calling_reload` with `isIdle: false`, then `reload_returned`, no `session_shutdown`). The guard is `handleReloadCommand()` in `modes/interactive/interactive-mode.js:5369-5376` (`isStreaming` or `isCompacting`).

Reload while idle emitted `session_shutdown` reason `reload`, then `session_start` reason `reload` from a new extension runtime, with the same session ID, file and leaf.

Escape always ends in `agent_settled` (the `finally` in `_startRun`, `core/agent-session.js:1433-1441`). So a request still `running` under the current nonce at a `reload` startup only happens if the bridge missed `agent_settled`. The spec's rule to mark it `interrupted` is still correct and costs nothing.

### 8. `ctx.shutdown()`: holds

`/p-shutdown` called `ctx.shutdown()`. The log shows `session_shutdown` with `reason: "quit"`, then the process exited and the tmux server went with it.

### 9. Trust flags: holds

A cwd with `.pi/settings.json` and `.pi/extensions/proj.ts`, and an empty throwaway agent directory (no `trust.json`):

- **No flag (control):** the `Trust project folder?` selector appeared and `session_start` never fired.
- **`--approve`:** `session_start` with no prompt, `ctx.isProjectTrusted()` true, and the project extension loaded.
- **`--no-approve`:** `session_start` with no prompt, `isProjectTrusted()` false, the project extension not loaded, and the notice `This project is not trusted...` shown.

Neither flag wrote `trust.json`. `resolveProjectTrusted` returns `trustOverride` before consulting extensions, the trust store or the UI (`core/project-trust.js:18-21`). A user-level `project_trust` extension (such as this repo's `worktree-trust`) cannot override the flags.

### 10. Tool allowlist: holds

`--tools read,subagent_report,no_such_tool` gave active tools `["read", "subagent_report"]`. Pi showed no error or warning for `no_such_tool`.

The spec registers child-mode tools in `session_start`, not in the extension factory, so I also tested that. A tool registered in `session_start` and named in `--tools read,late_tool,no_such_tool` was active (`["read", "late_tool"]`). With `--tools read` it was absent from both `getActiveTools()` and `getAllTools()`. With no allowlist, the factory-registered `subagent_report` was active next to `read`, `bash`, `edit` and `write`.

## Proposed contract changes

For the operator to decide. The spec and issue bodies are unchanged.

**A. Probe 2 failure (required).** Replace the first sentence of §8 Settlement ("Record the `outcome` from `agent_before_settle`.") with:

> Reset the recorded outcome at each `agent_start`, and keep the last `agent_before_settle` outcome before `agent_settled`. Pi skips `agent_before_settle` when Escape aborts a run, so `agent_settled.aborted` is the only abort signal. If `agent_settled` arrives with `aborted: false` and no recorded outcome, record `failed` / `error` with `Pi settled without an outcome`.

**B. Probe 1 condition (clarification, recommended).** Add to §7 after "Pi arguments are identical for first launch and resume":

> The tmux `-c` directory is always `child.json` `cwd`. With `--session-dir`, Pi matches `--session-id` only against sessions whose recorded cwd is the launch cwd. From another directory, or when tmux falls back to `$HOME` because the directory is gone, Pi silently starts a new empty session with the same ID. `ensureLive` returns `failed` without launching when `cwd` is not an existing directory.

**C. Probe 7 answer (wording only).** Replace the **Verify** sentence in §8 Startup step 1 with:

> Pi refuses `/reload` and `ctx.reload()` while a run is streaming, and Escape always reaches `agent_settled`, so this case only arises if the bridge missed settlement.
