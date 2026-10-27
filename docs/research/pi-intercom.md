# pi-intercom: transport, delivery and lifecycle

## Scope

This note examines [`nicobailon/pi-intercom`](https://github.com/nicobailon/pi-intercom) at commit [`02913ed`](https://github.com/nicobailon/pi-intercom/tree/02913edcd7b1bdb21b480852ff82f674d309c651), tag `v0.18.1` (2026-10-22), and compares it with [Tmux subagents V1](../specs/tmux-subagents.md). It asks what is worth reusing for parent-child messaging and follow-ups, and what actively conflicts with the spec.

Method: a disposable read-only clone at the pinned commit. Nothing was installed, executed, or configured; no Pi session, broker, or tmux server was started. Claims below come from that source, not from the README, except where the README is cited as documentation. Pi behaviour was checked against the installed `@earendil-works/pi-coding-agent@1.3.0` docs and distribution.

License: MIT, `Copyright (c) 2026 Nico Bailon` ([LICENSE](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/LICENSE)). Packaging is a Pi package (`pi.extensions`, `pi.skills`) with `tsx` as its only runtime dependency ([package.json](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/package.json#L1-L60)).

## What it actually is

pi-intercom is a 1:1 peer mesh for interactive Pi sessions on one machine. A standalone broker process sits between sessions; every participating session loads the same extension, connects to the broker, and addresses peers by session ID, name, ID prefix, or cwd. There is no parent-child relationship in the transport: the only parent-child awareness is (a) an optional child-only tool that resolves its supervisor from environment variables, and (b) an event contract with a different extension, `pi-subagents`.

Two consequences matter for us. First, the README's "sessions can coordinate" framing hides that the design is a daemon with its own process lifetime and protocol. Second, the parent-child path is not a first-class protocol; it is generic peer messaging plus conventions.

## Transport and protocol

- Transport: Unix domain socket at `$PI_CODING_AGENT_DIR/intercom/broker.sock` (default `~/.pi/agent/intercom/broker.sock`); a Windows named pipe, or opt-in loopback TCP with a secret endpoint file when `PI_INTERCOM_TRANSPORT=tcp` ([broker/paths.ts#L74-L118](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/paths.ts#L74-L118)). Directory mode `0700`, runtime files `0600` ([broker/paths.ts#L5-L8](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/paths.ts#L5-L8)).
- Framing: 4-byte big-endian length plus JSON, 1 MiB frame cap, and a socket destroyed once 8 MiB of writes is queued to a peer that stopped reading ([broker/framing.ts#L1-L30](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/framing.ts#L1-L30)).
- Handshake: `health` probe, then one `register` per connection. The broker replies `registered` with a feature list (`extension-bus-v1`, `exact-send-v1`); clients gate newer operations on those flags ([broker/broker.ts#L459-L650](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L459-L650), protocol message union in [types.ts#L152-L211](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/types.ts#L152-L211)).
- Guards inside the broker: max 128 sessions, 32 unregistered connections, 1 s registration timeout, token-bucket rate limit, mandatory registration before any other verb ([broker/broker.ts#L32-L53](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L32-L53), `#L332-L450`).

This is a socket protocol between processes. It is not tmux-based and has no notion of panes, sessions, windows, or worktrees; `tmuxPane` is carried only as an informational roster field read from `$TMUX_PANE` ([types.ts#L53-L61](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/types.ts#L53-L61), [index.ts#L603-L609](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/index.ts#L603-L609)).

## Discovery, identity, session scope

Identity is a string chosen by the connecting process. Registration accepts a caller-supplied `sessionId`; otherwise the broker mints a UUID ([broker/broker.ts#L496-L520](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L496-L520)). The extension's default is the Pi session ID, overridable by `PI_INTERCOM_STABLE_ID`, `config.stableId`, or an `intercom:session-identity` event that another loaded extension can answer synchronously with `claim(id)` ([index.ts#L596-L601](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/index.ts#L596-L601), `#L2059-L2069`). Because the default is the Pi session ID, resuming the same Pi session reuses the same address, while `/new` produces a new one.

Single-writer rule: a registering process that presents an ID already held by a *live* different pid is refused with `E_SESSION_HELD` and the holder keeps the ID and its mail; liveness is a `kill(pid, 0)` probe ([broker/broker.ts#L536-L566](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L536-L566), [runtime-claim.ts#L3-L22](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/runtime-claim.ts#L3-L22)). This is the closest thing in the project to our "one Pi writer per saved child" requirement, and it is enforced by the shared broker rather than by files.

Scoping: `PI_INTERCOM_SCOPE_ID` (or `/intercom-pool`) is an opaque routing scope. Sessions only list, address, queue mail to, and broadcast presence within the exact same scope; unscoped sessions never cross into scoped ones ([config.ts#L21-L32](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/config.ts#L21-L32), [broker/broker.ts#L185-L210](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L185-L210), scope test at [intercom.integration.test.ts#L784](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/intercom.integration.test.ts#L784)). A scope is not an ACL: it partitions traffic, it does not authorize a sender to a recipient.

Directory identity uses canonical paths, not strings: `normalizeCwd` resolves and `realpath`s, falling back to the resolved path when the directory is gone (`cwd.ts`). That is the same "canonical filesystem identity" concern the V1 spec raises for worktree grouping (the former `tmux-subagents-v1.md` §2, now [tmux-subagents.md §3](../specs/tmux-subagents.md#3-identities)).

## Persistence and delivery states

The broker persists almost nothing, and what it persists is not the message stream:

| State | Where | Lifetime |
|---|---|---|
| Connected sessions, ask edges, receipt routes, delivery records | broker memory | process lifetime |
| Queued mail for disconnected sessions | broker memory | 24 h TTL, max 256 messages, evicted oldest-first with `E_DELIVERY_EVICTED` ([broker.ts#L1107-L1145](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L1107-L1145)) |
| Delivery idempotency records | broker memory | 1 h, max 4096 ([broker.ts#L50-L51](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L50-L51)) |
| Pending asks (`askEdges`) | broker memory **and** `intercom/pending-asks/*.json` | ask timeout, default 10 min ([broker.ts#L1367-L1412](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L1367-L1412), [config.ts#L10-L19](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/config.ts#L10-L19)) |
| Extension channel state | `intercom/extension-state/<sha256>.json` + `.bak` | until overwritten |
| Delivered inbound message | the recipient's Pi session file, as a `custom_message` entry | session lifetime |

A queued message does not survive a broker restart. The broker is the only holder, and its mailbox is a plain array in memory; the only reason it stays alive when idle is that array being non-empty ([broker.ts#L440-L458](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L440-L458), and the v0.18.0 changelog entry that fixed the previous 5-second data loss). This is directly observable in the design: the durable store is Pi's own session file for messages already injected, nothing else.

Distinguishing the four states the V1 spec asks about:

- **Accepted by the sender side**: `intercom.send()` resolves when the broker replies `delivered`/`delivery_failed`. The client waits up to 10 s, then rejects with "Send timeout" ([broker/client.ts#L638-L700](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/client.ts#L638-L700)).
- **Queued**: `delivery: "queued"` when the target is disconnected and the message is not a blocking ask.
- **Delivered to a live socket**: `delivery: "socket_delivered"`, but for a receipt-promising receiver the broker only reports that after the receiver's `receiver_received`/`acknowledged` receipt, with a 5 s fallback of `delivery: "unknown"`, `outcomeKnown: false`, `retryable: true` ([broker.ts#L1162-L1210](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L1162-L1210)). The comment states the reason: "a socket whose process died still accepts writes".
- **Injected or acknowledged by the receiver, not proof of model consumption**: `injected`, emitted after `pi.sendMessage(...)` succeeds; `acknowledged` means the receiver accepted the message and recorded it in `ReplyTracker`, not that a turn ran ([index.ts#L1406-L1448](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/index.ts#L1406-L1448)). Receipt statuses are a closed union in [types.ts#L118](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/types.ts#L118).

Two deliberate limits: a blocking ask is refused when the target is disconnected (`E_TARGET_DISCONNECTED`, "blocking asks are not queued", [broker.ts#L862](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L862)), and a message that arrives while the recipient is replacing or shutting down its session gets an `expired` receipt instead of vanishing silently.

Duplicate suppression exists at two layers, both volatile:

- Broker: `deliveryRecords` keyed by `(senderSessionId, messageId)`; a replay with an identical content fingerprint is answered from the record, a replay with different content is rejected as `E_MESSAGE_ID_REUSE` ([broker.ts#L1225-L1254](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L1225-L1254), fingerprint definition in [broker/protocol.ts#L164-L179](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/protocol.ts#L164-L179)).
- Receiver: an in-memory `(fromId, messageId)` set, 1000 entries, 1 h ([index.ts#L48-L49](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/index.ts#L48-L49), `#L747-L764`).

Both are lost on restart, so the project's real guarantee is "no duplicate within one broker lifetime and one receiver lifetime", not exactly-once. Nothing in the code claims otherwise.

## followUp vs steer, and wake policy

Pi 1.3.0's `sendMessage` options are `triggerTurn` and `deliverAs: "steer" | "followUp" | "nextTurn"` (`dist/core/extensions/types.d.ts#L1255-L1266`). The implementation resolves them as: streaming plus `triggerTurn !== false` queues into `agent.followUp` or `agent.steer`; not streaming plus `triggerTurn` starts a run; not streaming without `triggerTurn` appends the message with no turn; `nextTurn` holds it as context for the next prompt (`dist/core/agent-session.js#L1802-L1870`). A follow-up queued on a streaming agent lives in the agent's in-memory queue until it is consumed, which corroborates the V1 spec's statement that Pi's follow-up queue is not durable delivery.

pi-intercom's policy is a config choice, not a fixed rule:

- `inboundTrigger: "always" | "replies" | "never"` decides whether an inbound message may start a turn at all (`index.ts#L1303-L1313`).
- `busyDelivery: "steer" | "human-first"` decides what happens to a peer arriving mid-run. The default steers ([config.ts#L80-L96](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/config.ts#L80-L96)).
- The delivery call is `pi.sendMessage({customType: "intercom_message", ...}, startTurn ? {triggerTurn: true} : trigger ? undefined : {deliverAs: "steer"})` ([index.ts#L1315-L1348](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/index.ts#L1315-L1348)). Note the shape: steer is the fallback whenever a turn is not being started.
- An idle session is woken with `triggerTurn` on Pi ≥ 1.2.0, and on older Pi with a synthetic `sendUserMessage("New intercom message above.")` because `before_agent_start` was skipped for trigger-turn runs on those versions (`#L1343-L1349`, version gate at `#L163-L170`).
- A busy session without a UI cannot answer at all; the extension auto-replies "cannot respond while it is working" and drops the ask (`#L1354-L1378`). This is a surprising behaviour worth knowing before copying the design.

Two mechanisms here are genuinely reusable:

1. **Wake coordination.** pi-intercom and pi-subagents both wake idle Pi sessions, and a second wake inside the preflight gap throws "Agent is already processing a prompt". The fix is a cross-extension reservation stored on `globalThis` under `Symbol.for("pi.idle-wake.v1")`, keyed by `SessionManager` with a 10 s expiry (`idle-wake.ts`). Our child bridge and parent extension will hit exactly this race when a report arrives as the operator also types.
2. **Held-then-released inbound queue.** While the session is busy without a run (for example during manual compaction, where an appended custom entry can be discarded), messages are held in an array, receive a `queued` receipt, and are flushed when a run starts. The queue is memory-only and discards on shutdown by design (`index.ts#L1380-L1405`; tests "shutdown discards inbound messages held during compaction", "runtime replacement discards held inbound messages").

## Closed parent, reload, resume, process lifetime

- **Reload.** `session_shutdown` disconnects the client and clears reply tracking and held messages ([index.ts#L2197-L2230](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/index.ts#L2197-L2230)); `session_start` and a `turn_start` that observes a replaced session context start a fresh runtime ([index.ts#L2039-L2092](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/index.ts#L2039-L2092)). Nothing durable is lost for messages already injected; anything merely held is discarded. This is the behaviour our spec forbids treating as an exit — and pi-intercom does not treat it as one, because there is no child to drain.
- **Closed parent.** The parent is just another session. Mail for it queues under its ID for 24 h if the broker lives that long; an ask to it fails immediately. On resume, the same Pi session ID reconnects and the mailbox is flushed in registration order ([broker.ts#L1288-L1346](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L1288-L1346)). Mailbox recovery also matches a live session on `(explicit name, canonical cwd)`, so a same-named session elsewhere never inherits another project's mail; sessions carrying a runtime-generated fallback alias are excluded from that fallback ([broker.ts#L1477-L1493](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L1477-L1493)).
- **Process lifetime.** The broker is a detached, unref'd child spawned on demand under a `wx`-created lock file with stale-lock recovery, and it refuses to start if an existing pid file names a live process ([broker/spawn.ts#L130-L200](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/spawn.ts#L130-L200), `#L274-L300`). It exits 5 s after the last session disconnects, unless mail is queued. Shutdown ends every socket, clears all in-memory maps, unlinks socket/port/pid files, and `process.exit(0)` ([broker.ts#L1869-L1901](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L1869-L1901)).
- **Liveness.** Each client round-trips a `list` probe (default 30 s interval, 5 s timeout) to detect a half-open socket after a broker kill; the broker drops a session silent for three declared intervals (90 s), with an explicit guard that resynchronises timestamps when a sweep arrives late because the machine slept ([broker.ts#L313-L331](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L313-L331), client side in `broker/client.ts#L112-L155`).

## Request correlation

Correlation is by message ID plus a broker-held ask edge, not by transcript position:

- An `expectsReply` message creates an `askEdges` entry and a disk `pending-asks` record keyed by its message ID (`broker.ts#L790-L812`).
- A reply must carry that `replyTo`; the broker rejects a reply whose `replyTo` has no live edge (`E_REPLY_TARGET`) and also refuses a mirrored ask pair (`E_MUTUAL_ASK`) (`broker.ts#L774-L796`).
- The asker registers a single `waitForReply` waiter with a timeout equal to the ask timeout; timeout is documented as *not* cancellation, and the error text says the delivered message may still be actionable (`index.ts#L802-L840`).
- The receiver keeps a `ReplyTracker` keyed by message ID for `expectsReply` messages, plus a "current turn context" chosen at `turn_start` so a bare `reply` answers the ask this turn is about (`reply-tracker.ts#L66-L83`). Its regression history is instructive: v0.17.1 fixed a bare `reply` answering an older, non-triggering message because that context had stayed queued ([CHANGELOG.md#L39](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/CHANGELOG.md#L39)).
- Misdirection guard: during a turn that is answering an ask, a non-reply `send` to a different target is refused with the expected `replyTo` (`index.ts#L1919-L1928`).

What is absent: any relation to Pi session entries or branches. Answers are in-memory messages, and `waitForReply` resolves on receipt, so the "exact answer entry on the active branch" problem the V1 spec solves with `getBranch()` does not exist here — and neither does its guarantee.

## Provenance, trust, arbitrary recipients

- There is no authorization layer. Any process that can open the socket can register, and can then message any session in the same scope. The broker's `trustedLocal` is derived from the transport being a local socket, not from the peer ([broker.ts#L568](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/broker/broker.ts#L568)). The README states the posture plainly: "Client-supplied cwd/model/pid/status are display metadata, not authentication" ([README.md#L647](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/README.md#L647)).
- Provenance is generated receiver-side from the broker-supplied `from` record, not from model text. The injected envelope is `**From <name> (<cwd>)**` plus a metadata line with message id, sender sequence, timestamps, supersede/retry references (`index.ts#L1315-L1340`, `#L662-L676`). Attachments are appended as fenced sections, not first-party content.
- The model-supplied content is therefore clearly framed, but framing is not permission: the extension has no allowlist, no sender verification, and no way to express "this child may only talk to its parent". The child-only `contact_supervisor` tool is a *convention*: it resolves the supervisor from `PI_SUBAGENT_ORCHESTRATOR_TARGET`/`…_SESSION_ID` and refuses to run without that metadata, but the ordinary `intercom` tool remains available to the same child for arbitrary sends ([index.ts#L230-L248](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/index.ts#L230-L248), `#L2331-L2410`). The skill file says as much: "A subagent may use regular `intercom`" ([skills/pi-intercom/SKILL.md#L243-L248](https://github.com/nicobailon/pi-intercom/blob/02913edcd7b1bdb21b480852ff82f674d309c651/skills/pi-intercom/SKILL.md#L243-L248)).
- Cross-machine messages carry an explicit `crossMachine` provenance with `trust: "ssh-asserted"` and are rendered as "unverified cross-machine" (`protocol.ts#L118-L140`). Out of scope for V1, but it is a good example of labelling unverifiable origin instead of implying authentication.
- `confirmSend` gates interactive non-reply sends behind a UI confirmation and fails closed when no UI exists. Inbound auto-triggering fails closed to `never` if `config.json` is malformed (`README.md#L476`). Those are the only trust controls.

## Concurrency and atomicity

- Serialisation comes from a single-threaded broker that owns all routing state. There is no file-based mutual exclusion between Pi processes for message ordering; correctness depends on the broker being the only writer.
- Per-session writes are single-socket writes. The one bulk path (mailbox flush) is paced on `writableLength` and resumes on `drain` (`broker.ts#L1310-L1325`).
- The durable state file uses temp file + `fsync` + optional `.bak` copy + `rename` + directory `fsync`, with an optimistic `expectedRevision` compare-and-set and a payload SHA-256 in the envelope (`broker/extension-state.ts#L120-L196`). This is the strongest durability pattern in the repository and matches the V1 spec's "atomic replacement for snapshots" requirement.

## Cleanup

On shutdown the broker ends every socket and clears all maps before unlinking `broker.sock`, `broker.port.json` and `broker.pid`. Mailbox entries, ask edges, receipt routes, disconnected-session records and delivery records each have a TTL prune on the paths that touch them. `pending-asks` files are pruned by expiry on startup and on ask-edge pruning. A crashed broker leaves a stale socket file, which the next startup unlinks (after refusing to replace a live pid).

There is no removal of Pi session files, no worktree knowledge, and no attention-notification state: cleanup is scoped to `~/.pi/agent/intercom`.

## Tests and license

25 test files, roughly 330 `test()` cases, dominated by `intercom.integration.test.ts` (140) and `reply-tracker.test.ts` (25), plus focused broker suites for framing, spawn/claim, liveness, paths, and extension state. They are behavioural and adversarial rather than unit-shaped: stable-ID takeover, stale socket mutation, forged `replyTo`, mutual asks, receipt-gated delivery, heartbeat eviction, mailbox-over-write-cap, endpoint epoch rebound, supersede scoping, compaction-held messages, wake races with pi-subagents, and a Windows state-save regression. The test script is plain `tsx --test`; there is no CI configuration in the repository, so the suite is evidence of intent, not of a passing gate at this commit.

pi-intercom's MIT license permits adaptation of its code with the required notices. It does not resolve the separate licensing question for `badlogic/pi-subagent`.

## Use versus reuse

**Dependency.** Poor fit. It is a Pi extension plus a daemon, not a library: `main` is `index.ts`, everything is ESM TypeScript run through `tsx`, and the only exported seams are the broker client, an extension-channel registry, and a few helpers. Depending on it would add a second machine-wide daemon, its protocol, its process-lifetime rules, and a requirement that every child Pi process loads the same extension at a compatible version. It also brings a peer mesh we deliberately excluded.

**Adaptation.** Realistic but partial. The parts worth adapting are mechanisms, not the architecture: length-prefixed framing, receipt-gated delivery with an explicit `unknown` outcome, message-ID plus content-fingerprint idempotency, heartbeat/eviction, the atomic revision-CAS state file, the idle-wake reservation, and the `E_SESSION_HELD` single-writer claim. Each is small, independently testable, and expressible against our file and tmux seams. Copying is acceptable under MIT with attribution.

**Independent implementation.** The right default for the protocol surface. Our V1 needs parent-owned, persisted, acknowledged reports with branch-exact answers; that is a different contract from "best-effort 1:1 mail between interactive peers", and bending the broker to it would mean rewriting its core (durable mailbox, ownership ACL) while inheriting its lifetime and failure modes.

## Incompatibilities with V1

1. **Durability.** Queued mail lives only in broker memory. V1 requires "persist the report before acknowledging acceptance". A pi-intercom dependency cannot satisfy that without replacing its mailbox.
2. **Ownership.** Any session in a scope can address any other. V1 requires a report tool that "cannot select an arbitrary parent or claim another child's identity". A self-asserted-ID transport provides provenance labels, not permission.
3. **Steer-first delivery.** Default `busyDelivery: "steer"` and the `deliverAs: "steer"` fallback contradict the V1 rule that child-to-parent reporting and parent-originated follow-ups never steer an active turn.
4. **No post-completion reporting.** `contact_supervisor` is scoped by its own description to in-task escalation ("Do not use for routine completion handoffs"), and task results travel through pi-subagents' own event/result path rather than as a durable report. V1's persistent report tool has no counterpart.
5. **Identity model.** A Pi session ID doubles as the intercom address, and `/new` changes it. V1 separates child conversation identity, parent conversation identity, delegation, request, and tmux address.
6. **Missing correlation guarantees.** Ask/reply correlation is transport-level and dies with the process; there is no branch awareness and no answer-entry reference. V1's exact-answer requirement cannot be met by this design.
7. **New moving part.** A broker daemon conflicts with the V1 stance that a supervisor/background daemon is out of scope, and adds a lifecycle (start lock, idle shutdown, mailbox-keeps-alive, socket cleanup) we would have to own.

## Mechanisms worth adopting (suggestions, not decisions)

1. **Delivery-outcome vocabulary.** Record `accepted` / `queued` / `delivered_to_process` / `consumed`, plus `outcomeKnown` and `retryable`, and an explicit `unknown` state that is recoverable rather than silently dropped. Intercom's `socket_delivered | queued | failed | unknown` plus receipt statuses is a useful reference for a hand-rolled protocol, and it maps cleanly onto spec §5's accepted/read distinction.
2. **Message-ID reuse detection.** Key idempotency on `(sender, messageId)` and reject a replay whose content differs. Cheap, and it turns an accidental duplicate send into a visible error instead of a second instruction.
3. **Reply-edge validation.** Reject a reply whose correlation ID has no outstanding request, and reject an attempt to have two live asks between the same pair. For `subagent_ask` this replaces "trust the replyTo" with a checked edge; it is the cheapest half of the correlation problem and does not require branch analysis.
4. **Single-writer claim with a pid probe.** A live-holder check is useful evidence for refusing takeover. It is not sufficient mutual exclusion by itself: independent callers must acquire an exclusive claim before probing and launching, with ownership-safe release and stale-claim recovery. The broker serializes identity claims centrally; a brokerless implementation must provide its own arbitration.
5. **Atomic revision-CAS state files.** The extension-state pattern (temp + fsync + rename + dir fsync, `.bak` fallback, `expectedRevision` CAS) is directly reusable for the registry snapshots that spec §8 requires, without needing a broker.
6. **Bidirectional liveness without a supervisor.** A declared heartbeat interval plus "three missed intervals means dead" gives dead-parent/dead-child detection for free, and the late-sweep guard (treat a sweep later than 2×interval + 1 s as clock/sleep skew, resynchronise) is the detail that keeps it from producing false evictions after a laptop sleeps. If we want bounded orphan handling without a daemon, this is the cheapest form.
7. **Wake reservation.** Adopt the `Symbol.for("pi.idle-wake.v1")` reservation so our bridge and any other extension do not race to wake the same idle Pi session. This is a concrete bug we will otherwise reproduce.
8. **Canonical path identity.** `realpath`-normalised cwd comparison for worktree ownership and for mailbox/record recovery, exactly as spec §2 requires, with a memoised normaliser.
9. **Explicit `unknown` on ambiguous launch/delivery.** Distinguish uncertain delivery from confirmed failure. Intercom exposes `outcomeKnown: false` with `retryable: true`, but our contract must not imply that a fresh-ID retry is safe: the earlier instruction may still execute, and deduplication must survive the relevant restart before same-ID retries are safe.

## Candidate V1 spec amendments worth considering

Each is a suggestion for discussion; none is an accepted decision, and none was applied to the spec.

- **§4/§5, delivery states.** Make the report/ask lifecycle states explicit and named (accepted, persisted, delivered, consumed), and require that a failure to reach `consumed` is visible rather than reported as success. Intercom's receipt statuses and its `unknown` outcome inform this vocabulary, but neither injection nor acknowledgment proves model consumption.
- **§4, follow-up delivery mapping.** Pin the Pi 1.3.0 mapping: while the parent is streaming, queue with `deliverAs: "followUp"`; while it is idle, deliver with `triggerTurn: true`. State that `deliverAs` alone does not start a turn when idle, so "never steer" needs both branches. Also record that `deliverAs: "nextTurn"` exists and is context-only.
- **§5, ask correlation.** Add an explicit requirement that an answer whose correlation ID does not match an outstanding request is rejected with a typed error, and that two concurrent asks between the same pair are refused. This is narrower than branch-aware answer references and closes the cheapest forgery/misdirection path.
- **§3/§8, single-writer claim.** Specify a claim artefact (pid + generation) with an alive-process probe, and require that a resume attempt against a live claim fails honestly rather than racing the writer. Intercom's `E_SESSION_HELD` is evidence that the naive "last writer wins" behaviour was a real bug, not a hypothetical.
- **§6, liveness versus draining.** Consider declaring a parent heartbeat on child records so a child can distinguish "parent quit" from "parent process died"; intercom's three-missed-interval rule plus its sleep-skew guard is a compact basis, and it does not require the deferred supervisor daemon.
- **§7/§8, ambiguous outcomes.** Add `outcomeKnown`/`retryable` as first-class fields on enqueued reports and follow-ups, so recovery can distinguish "definitely not delivered" from "unknown", mirroring `launch_indeterminate`.
- **§10, tests.** If any of the above mechanisms are adopted, add the adversarial cases the upstream suite already covers: forged correlation ID, ID reuse with changed content, reply to an expired request, resume against a live claim, heartbeat eviction, and mailbox overflow.

## Limitations of this note

- Everything is from a static read at one commit. Two paths were not exercised: the live broker/Pi interaction (no sessions were started) and the `pi-subagents` side of the child bridge, which lives in a different repository; the contract is described here only from the consuming side (`subagent:control-intercom`, `subagent:result-intercom`, `subagent:result-intercom-delivery`, and the `PI_SUBAGENT_*` environment variables).
- The suite was not run, and the repository has no CI configuration, so test counts indicate coverage intent rather than a verified pass.
- Cross-machine transport (`cross-machine-*.ts`) was read only far enough to characterise its provenance labelling; it is out of scope for V1.
- The v0.18.1 release is recent. `CHANGELOG.md` records several delivery-correctness fixes in the preceding weeks (receipt-gated delivery, mailbox retention, stable-ID takeover, heartbeat eviction), which suggests the protocol's guarantees were still moving. Treat the code as the evidence, not the README's summary.
- No claim is made about untested Pi branch/compaction interactions: pi-intercom does not attempt branch-aware answer correlation, so it offers no evidence either way for spec §4's proposal.
