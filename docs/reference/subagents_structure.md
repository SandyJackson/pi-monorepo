# Subagent delegation architecture

This document describes the implemented design of `packages/herdr-subagent` — durable module ownership and invariants only. Vocabulary follows `CONTEXT.md`: **subagent delegation**, **delegated task**, **delegated task number**, **delegated task outcome**, **visible subagent session**, and **callable agent catalog**.

The agent-state projection that backs delegated-turn settlement is Herdr-managed (see [ADR-0004](../adr/0004-keep-herdr-agent-state-managed-by-herdr.md)); this module consumes it as an external boundary and observes it through `agent.get`.

## Module ownership

```text
packages/herdr-subagent/
├── index.ts            Pi lifecycle adapter: snapshot + tool registration
├── agents.ts           Agent discovery and merge (catalog source)
├── subagent-tool.ts    Tool schema, semantic validation, presentation
├── pi-session.ts       Pi session identity and exact answer references
└── herdr/
    ├── delegation.ts   The ordered delegation operation
    ├── session.ts      Visible subagent session lifecycle
    └── rpc.ts          Herdr JSON-RPC socket transport
```

| Module | Owns | Depends on |
|---|---|---|
| `index.ts` | Building the session-scoped callable agent catalog from Pi context, registering one `subagent` tool, binding the concrete Herdr delegation function and environment, replacing a leased child session's private startup placeholder with its delegated-task file | `agents.ts`, `subagent-tool.ts`, `herdr/delegation.ts`, `herdr/session.ts` |
| `agents.ts` | Discovering user and trusted project agents, merging with project-overrides-user precedence, formatting and resolution | Pi's `parseFrontmatter`/`getAgentDir` |
| `subagent-tool.ts` | Strict request schema, per-task validation against the catalog, one injected delegation call, final content/details rendering | `agents.ts`, `pi-session.ts`, `herdr/*` contracts |
| `pi-session.ts` | Reading Pi session JSONL: header identity, exact answer references, answer resolution | nothing (fs only) |
| `herdr/delegation.ts` | Herdr environment validation, delegation tab creation, ordered launch/observation, total ordered outcomes | `herdr/session.ts`, `herdr/rpc.ts` |
| `herdr/session.ts` | Launching one visible subagent session and observing its initial delegated turn (the session itself persists beyond the turn under Herdr's management) | `pi-session.ts`, `herdr/rpc.ts` |
| `herdr/rpc.ts` | Newline-delimited JSON-RPC over the Herdr Unix socket | nothing (net only) |

Test seams are intentional and few: `subagent-tool.ts` receives one injected delegation function; `herdr/rpc.ts` exposes the transport as a callable boundary that tests replace with a scripted adapter.

## Callable agent catalog

- Snapshotted **once per Pi session** in `index.ts` on `session_start`; refreshed only by Pi's session lifecycle.
- Combines user agents with project agents when the parent project is trusted; project definitions override user definitions of the same name.
- Both the tool description and execution-time resolution use the same snapshot, so the model can never resolve a task against agents absent from its description.

## Pi tool: validation and presentation

- The TypeBox schema is strict (`additionalProperties: false`, at most 8 tasks); Pi itself rejects malformed or obsolete request shapes — no legacy-key knowledge exists here.
- Each well-shaped task receives its **delegated task number** (one-based position) exactly once, at parse time; that same task record is carried through validation, execution, details, and presentation. No second identity is generated.
- Task-level failures (empty agent, empty instruction, unknown agent) become positional `invalid` outcomes; valid siblings still execute. Structurally malformed calls are rejected whole by Pi.
- A call with no tasks lists the catalog. A delegation whose tasks are all invalid never initializes Herdr.
- Herdr environment and tab-creation failures **throw before any launch** and surface through Pi's native tool-error channel; once launch processing begins, per-task failures — including pane-split failures — become positional delegated task outcomes instead.
- Presentation resolves an answer's exact reference **only at presentation time** — answer text never flows through the delegation operation or persists in `details`. Truncation uses Pi's canonical `truncateHead` (head bytes/lines) with the full answer remaining addressable in the referenced session entry.
- One task renders its direct answer or a status-specific explanation; multiple tasks render `Delegation: X/N tasks completed` plus request-ordered headings. The delegated task number is canonical; agent names are descriptive only. `details.tasks[]` carries `taskNumber`, `agent`, and the outcome's status-specific metadata — never answer text.

## Ordered delegation operation

`herdr/delegation.ts` implements one concrete operation — not a class hierarchy, not a scheduler:

1. Validate bounds (≤ 8 valid tasks) and the already-aborted case before contacting Herdr.
2. Serialize tab creation per workspace behind a process-wide lock. The lock covers tab creation and sequential launches only; it never waits for turns to settle. Shared Herdr environment or tab-creation failures throw before any launch.
3. Give every delegation its own new Herdr tab, created unfocused and labeled by the caller's optional `label` (default: the delegated agents' names); the tab's root pane serves the first launch attempt, and subsequent placements split from the tab's most recent pane. Splits go down after a launched or possibly launched child; if earlier launches were confirmed failures and the next task needs a different cwd, the split goes right. Existing tabs are never discovered or reused. A confirmed launch failure frees its pane for reuse by a same-cwd sibling; a pane is never reused after an indeterminate launch or for a task with a different cwd.
4. Launch every valid task **sequentially** and start each task's observation immediately at its confirmed launch while later launches continue. There are no wave barriers.
5. Await all observations concurrently, then merge outcomes back into request order.

**Invariant — total ordered contract:** once launch processing begins, every delegated task produces exactly one delegated task outcome, returned in request order carrying the original task record and delegated task number.

## Visible subagent session lifecycle

`herdr/session.ts` launches one visible subagent session and observes its initial delegated turn. The visible subagent session itself persists independently of that turn under Herdr's management; this module never closes it.

- **Launch-input ownership (private):** the agent's system prompt and sanitized delegated task reach the visible subagent session through temporary files owned entirely by this module. The system prompt path is passed through `--append-system-prompt`. The task path is passed through a private extension flag. The input handler replaces one exact startup placeholder only when the child was started with that flag. It reads the flag and task file when the matching input arrives, after Pi has applied CLI flag values; those values are not available during extension factory evaluation. This preserves the sanitized user-message shape without placing the task text in Fish's input buffer or enabling file substitution in ordinary sessions. Cleanup is best-effort, idempotent, and non-throwing: confirmed launch failures clean up immediately, inputs the delegated turn demonstrably consumed are cleaned up by the end of its observation, and inputs whose consumption was never confirmed are cleaned up after a conservative fallback delay. Launch-input lifecycle details are never part of a public contract.
- **Launch:** argv is built from the model, tools, optional system-prompt path, private task-file flag, and short startup placeholder. Task control characters are stripped before the task file is written. A pane label is allocated with collision retries, transient pane-busy errors are retried, then `agent.start` runs. Explicit server errors are confirmed failures; only transport ambiguity after `agent.start` may have executed, or a successful response without a usable pane id, is `launch_indeterminate`.
- **Observation:** polls Herdr's `agent.get` projection. Startup idle is ignored; completion requires observed activity plus two consecutive settled polls. The per-task timeout deadline starts at confirmed launch.
- **Session reference:** the first observed session path yields the Pi session `{id, path, cwd}` from the JSONL header; the reference persists through completion, timeout, abort, or closure.
- **Answer capture:** stable settlement records the exact `{path, entryId}` reference of the latest terminal assistant entry — never the text itself.
**Persistent-pane invariant:** timeout, cancellation, and abort stop only parent-side observation. Nothing in this module ever closes a Herdr pane or a visible subagent session; timed-out and aborted visible subagent sessions remain live for manual inspection or a later turn.

## Delegated task outcomes

Once launch processing begins, every accepted delegated task settles into exactly one outcome; there is no redundant `success` flag and no scheduler-specific `not_started` state:

| Status | Meaning |
|---|---|
| `completed` | Turn settled; exact answer reference (or `null` if none was persisted) |
| `timed_out` | Deadline passed while observing; session remains live |
| `aborted` (before_launch / observing) | Cancellation before a session existed, or while observing a live one |
| `session_closed` | The visible subagent session's pane closed before the delegated turn settled |
| `launch_failed` | Confirmed launch failure with the server/tooling error |
| `launch_indeterminate` | `agent.start` may have executed without a trustworthy response — transport ambiguity after the request, or a response without a usable pane id; the possible pane is reported |
| `observation_failed` | Observation defect; the visible subagent session may still be live |

## Herdr RPC transport

`herdr/rpc.ts` is the only external seam: one newline-delimited JSON-RPC call over one Unix-socket connection, with request/response correlation by protocol request ID. Request IDs correlate **protocol responses only** — they are not delegated task identity. Explicit server errors surface as typed response errors; abort and timeout are enforced per call.

## Pi session identity and exact answer references

`pi-session.ts` gives delegated task outcomes stable, addressable results instead of transported text:

- **Identity:** the first non-blank JSONL line must be a `session` header with `id` and `cwd` (Pi's 1 MiB header bound is honored).
- **Answer reference:** the terminal assistant entry (`stop`/`end_turn`) to address for the answer — the latest one with substantive text, or the first whitespace-only terminal entry when none is substantive — identified by its persisted entry ID. Entry IDs are stable, so later appends or branches cannot make a later turn look like this task's answer.
- **Resolution:** `readAnswer` streams the file once and exits on the entry-ID match, used only during final presentation.
