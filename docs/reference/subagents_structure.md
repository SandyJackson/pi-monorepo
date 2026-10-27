# Subagent delegation architecture

This document describes the implemented design of `packages/tmux-subagent`: module ownership and invariants only. The full contract, including record shapes and outcome texts, is the spec [Tmux subagents V1](../specs/tmux-subagents.md). Vocabulary follows `GLOSSARY.md`: **subagent delegation**, **delegated task**, **subagent child**, **subagent request**, **subagent request result**, **subagent retrieval outcome**, **subagent report**, and **callable agent catalog**.

The workspace owns child run state ([ADR-0011](../adr/0011-workspace-owns-subagent-run-state.md)). Each child is an interactive Pi session in its own tmux session (`sa-<childId>`) on one private server (`tmux -L pi-subagents`). The parent and the child exchange files under Pi's agent directory; nothing reads a terminal to learn what a child did.

## Module ownership

```text
packages/tmux-subagent/
├── index.ts          Pi adapter: parent or child mode, lifecycle hooks, tool registration
├── agents.ts         Agent discovery and merge (catalog source)
├── pi-session.ts     Session JSONL reading and branch-based answer selection
├── subagent-tool.ts  `subagent` schema, validation, outcome presentation
├── ask-tools.ts      `subagent_ask` and `subagent_retrieve`
├── store.ts          State paths, ID allocation, atomic JSON writes, record validation
├── tmux.ts           TmuxExec (execFile) and argv builders
├── launch.ts         ensureLive: start or find a child and wait for readiness
├── parent.ts         createParentRuntime: delegate, ask, retrieveResult, drain, reports
├── child.ts          Child bridge and `subagent_report`
└── cli.ts            pick, open, list, stop (plain node, no Pi imports)
```

| Module | Owns | Depends on |
|---|---|---|
| `index.ts` | Deciding mode and depth in `session_start` from `--subagent-child` and `child.json`; building the catalog; registering tools; binding drain to `session_shutdown` | everything below except `cli.ts` |
| `agents.ts` | Discovering workspace, user, and trusted project agents; project > user > workspace precedence; resolution | Pi's `parseFrontmatter`/`getAgentDir` |
| `pi-session.ts` | Exact answer references `{path, entryId}` and selecting the answer to a request on the active branch | nothing (fs only) |
| `subagent-tool.ts` / `ask-tools.ts` | Strict schemas, per-task validation, minute-to-millisecond conversion, presentation with `truncateHead` | `parent.ts` types, `pi-session.ts` |
| `store.ts` | The state layout and its single-writer records; owning-worktree resolution | nothing (fs only) |
| `tmux.ts` | Every tmux and Pi argv; the private server's `tmux.conf`; the launch environment | nothing (child_process only) |
| `launch.ts` | `ensureLive`: one Pi process per child, readiness by launch nonce | `store.ts`, `tmux.ts` |
| `parent.ts` | Ordered delegation, follow-ups, retrieval polling, drain, report delivery | `store.ts`, `launch.ts` |
| `child.ts` | Dispatching requests into the child's Pi, settling results, blocked state, drain exit, reports | `store.ts`, `tmux.ts`, `pi-session.ts` |
| `cli.ts` | Worktree-scoped picker, inspection float, list, and stop | `store.ts`, `tmux.ts`, `launch.ts` |

Test seams: `ExecuteDelegation` for the tool, a scripted `TmuxExec`, a `Store` rooted in a temporary directory, and fake timers. Real Pi and real tmux run only in the `*.integration.test.ts` files, on disposable sockets.

## State and writers

State lives in `<agentDir>/subagents/children/<childId>/`. Every file has one writer: the parent writes `child.json`, `system-prompt.md`, `drain`, and `request.json`; the child writes `status.json`, `result.json`, and reports. No lock is needed. Records are written to a temporary file and renamed, so readers never see partial JSON. A record with the wrong version or shape is an error, never absence.

Live tmux state is discovered, never stored. A child is live when its tmux session exists. `status.json` counts as readiness only when its nonce equals the live session's `PI_SUBAGENT_NONCE`.

## Callable agent catalog

- Snapshotted once per Pi session in `session_start`; refreshed only by Pi's session lifecycle.
- Project agents are included only when the parent project is trusted.
- The tool description and execution-time resolution use the same snapshot.

## Delegation and follow-ups

`delegate` handles each valid task in order: check cancellation, allocate the child and write `r1`, `ensureLive`, then start the wait and move on. All waits are awaited together and outcomes return in request order. All-invalid delegations never touch tmux. `projectTrust` is true only when the parent project is trusted and the task cwd is at or beneath the parent's cwd; launches always pass `--approve` or `--no-approve`, so a hidden child never stops at a trust prompt.

`ask` resumes a stopped child before its capacity check (one running and one queued request at most) and before submitting, so a failed resume submits nothing. `retrieveResult` never launches and never writes; each call gets a fresh timeout. Loss requires two consecutive polls with no settled result and no live child.

**Invariant:** cancelling or timing out a wait ends only the wait. Submitted requests stay on disk and the child keeps running.

**Invariant:** every operation that takes a child ID checks that `child.json` names the caller's Pi session as parent.

## Child bridge

- **Readiness:** at `session_start` the bridge marks any `running` result from an older nonce `interrupted`, then writes `status.json`. It never re-runs interrupted work.
- **Dispatch:** when Pi is idle with no pending messages or open prompt, the lowest unsettled request is sent with `sendUserMessage`. It counts as started only after Pi confirms it (`agent_start` after the matching `input`, or `input` with `streamingBehavior`). Without confirmation it settles `failed` / `error` and is never resent.
- **Settlement:** on `agent_settled`, the request's user entry is located on the current branch after the dispatch leaf. The answer is the latest terminal assistant entry after it. Operator input during the request sets `humanIntervened`.
- **Blocked:** `ui_prompt_start`/`ui_prompt_end` and the `herdr:blocked` event from `@pi-workspace/herdr-contract` set and clear `blocked` in `status.json`.
- **Drain:** the child exits only when `drain` exists, it is idle, has no unsettled request or open prompt, and no client is attached. The check runs on transitions, never at startup. A blocked child stays.

## Lifecycle

| Pi event | Parent action |
|---|---|
| `session_start` | Create the runtime; delete `drain` from this session's children; rebuild delivered-report keys from history; start the report poller |
| `session_shutdown`, `reload` | Dispose only |
| `session_shutdown`, `quit` / `new` / `resume` / `fork` | Write `drain` to every owned child, then dispose |

Reports are delivered as `subagent_report` custom messages with `deliverAs: "followUp"`, in an envelope generated from the record. Delivery is confirmed by `message_end`; an unconfirmed report is resent once the parent is observed idle.

## Nesting

A depth-1 child is also a parent: it registers `subagent`, `subagent_ask`, and `subagent_retrieve` and runs its own runtime. Its children get `depth: 2`, copy its owning worktree, and register no parent tools. Draining a depth-1 child drains its grandchildren through its own `session_shutdown`.

## Picker and inspection

`cli.ts` resolves the owning worktree from the outer pane's current path and never falls back to all children. `open` runs `ensureLive` and then opens a modal floating pane (`new-pane -O`) on the operator's server that attaches to the child. Closing the float kills only the attach client. `stop` kills child tmux sessions; transcripts and records remain, and the next request or `open` resumes the child.
