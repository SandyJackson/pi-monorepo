# Migrating subagent delegation from Herdr to tmux

**Status**: research complete; subsequent design consolidated in [Tmux subagents V1](../specs/tmux-subagents-v1.md). No source changes made. The spec supersedes this document's proposed target design and records corrections to the findings below.
**Date**: 2026-10-23. **Branch**: `docs/herdr-to-tmux-subagents` at `69f348c`.
**Purpose of this document**: let a fresh agent pick this up and turn it into a final spec. It records findings that are *not* in any other artifact. Current architecture, invariants and outcome model are already documented elsewhere — see §2 and do not restate them.

---

## 1. The ask

The operator is moving their daily terminal environment back to tmux and wants subagent delegation to stop depending on Herdr. Two requirements:

1. **Preserve existing functionality** of `packages/herdr-subagent` (agent catalog, typed tool, ordered outcomes, exact answer references, persistent children).
2. **Add bidirectional communication**: a long-lived research subagent that returns a summary and *stays available* for follow-up questions, the way the operator already converses with it.

The result will be turned into a spec, so §6 lists the decisions that must be settled first.

---

## 2. Read these before designing (do not duplicate)

| Artifact | Why |
|---|---|
| [`docs/reference/subagents_structure.md`](../reference/subagents_structure.md) | Implemented design: module ownership, callable agent catalog, ordered delegation operation, outcome table, persistent-pane invariant |
| [`docs/reference/subagents_refactor_structure.md`](../reference/subagents_refactor_structure.md) | Rationale-level design; `:629` already names the extraction seam we now need ("A future non-Herdr runtime is deliberately not represented today… the single call from `subagent-tool.ts` to `executeHerdrDelegation()`") |
| [`docs/research/pi-interactive-subagents.md`](pi-interactive-subagents.md) | Prior-art analysis of `HazAT/pi-interactive-subagents`: activity snapshots vs. sidecars vs. session JSONL, stale-`done` correlation |
| [`docs/research/pi-worktree-patterns.md`](pi-worktree-patterns.md) | tmux-era prior art in §3 and §5, notably `RielJ/pi-git-worktrees` (hidden pool session, `destroy-unattached off`, `display-popup`) and the "terminal injection is racy" verdict |
| [`docs/adr/0004-keep-herdr-agent-state-managed-by-herdr.md`](../adr/0004-keep-herdr-agent-state-managed-by-herdr.md) | **Will be superseded.** With Herdr gone, nobody owns child state; the workspace must |
| [`docs/adr/0006-share-the-authored-herdr-event-contract.md`](../adr/0006-share-the-authored-herdr-event-contract.md) | `herdr:blocked` contract; survives as the trigger for a `blocked` child state |
| [`GLOSSARY.md`](../../GLOSSARY.md) | Vocabulary: *visible subagent*, *visible subagent session*, *subagent delegation*, *delegated task*, *delegated task number*, *delegated task outcome* |

Note that `GLOSSARY.md` defines *visible subagent* as "a child Pi agent operating in a Herdr-managed pane". That definition needs replacing; it is a real domain-model change, not a synonym swap.

---

## 3. Findings

### 3.1 Herdr's blast radius is smaller than it looks

Non-test lines: **1,981 total**, of which **1,039 (52%) are Herdr-specific**.

| Module | Lines | Herdr-specific |
|---|---|---|
| `packages/herdr-subagent/agents.ts` | 314 | No |
| `packages/herdr-subagent/subagent-tool.ts` | 295 | No, but imports contract types |
| `packages/herdr-subagent/pi-session.ts` | 265 | No (`readHeader` becomes unnecessary, see §3.8) |
| `packages/herdr-subagent/index.ts` | 68 | No, but wires the Herdr implementation |
| `packages/herdr-subagent/herdr/session.ts` | 558 | **Yes** |
| `packages/herdr-subagent/herdr/delegation.ts` | 359 | **Yes** |
| `packages/herdr-subagent/herdr/rpc.ts` | 122 | **Yes** |

Only three Herdr primitives are load-bearing:

- `agent.start` — `herdr/session.ts:248`
- `agent.get` (status + `agent_session` path) — `herdr/session.ts:404`
- `tab.create` / `pane.split` — `herdr/delegation.ts:128`, `:191`

**Two leaks in the claimed single-call seam** — both small, both must be fixed before the port:

1. Contract types live under `herdr/`. `subagent-tool.ts` imports `DelegatedTaskExecution`/`DelegatedTaskRecord` from `./herdr/delegation.ts` and `DelegatedTaskOutcome`/`DEFAULT_TURN_TIMEOUT_MINUTES` from `./herdr/session.ts`. `subagent-tool.test.ts:7` does the same. These move to a neutral `delegation.ts` at package root.
2. `index.ts` imports the child-startup constants `DELEGATED_TASK_FILE_FLAG` and `DELEGATED_TASK_PLACEHOLDER` from `herdr/session.ts:87`. They belong to the child bridge, not to Herdr.

The injected function seam itself is clean: `ExecuteDelegation` at `subagent-tool.ts:108`, consumed by `createSubagentTool` (`:125`) and bound at `index.ts:56-64`. **The tool needs no change to accept a new backend.**

### 3.2 Upstream A — `badlogic/pi-subagent` (commit `4fc1fe5`, 1,020 lines, no tests)

Not a typed tool: a CLI (`spawn|status|rename|send|wait|stop|list`) plus a bundled skill instructing the model to call it through `bash`. The extension only adds `/subagent` attach and a status widget.

Primitives worth borrowing:

| Primitive | Location | Value to us |
|---|---|---|
| Durable run registry, atomic tmp+rename | `shared.ts:18` `RunMetadata`, `:71` `getRunsDir` | Replaces Herdr as the owner of run state (ADR-0004's removed premise) |
| tmux launch | `shared.ts:159` `launchRun` | `new-session -d -s <name> -x 120 -y 40 -c <cwd> -- env … pi --session …` |
| Child state hooks | `index.ts:276,281,286` (`agent_start`→busy, `agent_settled`→idle, `session_shutdown`→exited) | The replacement for `agent.get` |
| File inbox + steer/followUp | `shared.ts:43` `InboxMessage`, `:79` `inboxDir`; write at `subagent.ts:241`; poll at `index.ts:209` (250 ms); delivery at `index.ts:240` | The messaging layer we lack |
| `wait` completion rule | `subagent.ts:260` — `hasStarted && state==="idle" && no pending inbox` | Avoids the startup-idle trap |
| Branch-aware answer read | `shared.ts:236` `activeBranch`, `:254` `readLatestAssistant` | Fixes our defect §3.8 |
| Nested-spawn guard | `subagent.ts` via `PI_SUBAGENT_RUN_DIR` | Cheap recursion protection |
| Suspend on parent quit / relaunch on resume | `index.ts:150-190` | Optional for us; tmux children already outlive the parent |

Gaps that make a wholesale fork a net loss: no agent catalog (no `agents/*.md`, no frontmatter `model`/`thinking`/`tools`/`timeout`/system prompt), no typed tool, no per-task validation or positional outcomes, no `label`, no fan-out, no completion timeout at spawn, no blocked-state awareness, per-child sessions rather than per-delegation, and `readFileSync` over the whole session file (`shared.ts:254`).

**Licensing**: GitHub reports `license: null` and the tree has no `LICENSE`. Do not copy code. Reimplement the mechanisms.

### 3.3 Upstream B — `mitsuhiko/agent-stuff/extensions/subagent.ts` (687 lines)

Much closer to our shape: a **typed, blocking tool** with `onUpdate` progress, `details`, and `renderCall`/`renderResult` (`:438`, `:653`). Primitives worth borrowing:

| Primitive | Location | Why it is better than the alternative |
|---|---|---|
| **Private tmux server** at `~/.pi/agent/tmux-subagents.sock` | `:82` `tmuxSocketPath`, `tmuxArgs()` | Children never pollute the user's window list, and the server inherits *the parent process's* environment at creation — this removes the "tmux server has stale env" hazard that affects badlogic's default-server design |
| **`pi --attach-subagent <id>` re-exec** | `:20` `ATTACH_FLAG`, `:124` `attachToSubagentAndExit` | Works whether or not the user is inside tmux: it runs during argument parsing *before* the TUI starts, then `process.exit`s; it deletes `TMUX`/`TMUX_PANE` when crossing servers (the nested-tmux trap) |
| **In-process child reporter** | `:212` `registerChildReporter` | Uses `ctx.sessionManager.getBranch()` (`:195` `findLastAssistant`) — correct branch walk with no file parsing |
| **Robust Pi re-invocation** | `:169` `getPiInvocationParts` | Re-execs the same node+script or binary instead of assuming `pi` is on `PATH` |
| **Deterministic child session** | `:512` `--session-dir <runDir>/session --session-id <uuid>` | Removes session discovery entirely |
| **Live pane preview in the tool result** | `:261` `trimPane`, `:585` `capture-pane -p -J`, `#{pane_dead}` | "Visible subagent" without attaching; also the only way to surface a blocked question |
| **Explicit trust propagation** | `:500` `trusted`, `:526` `--approve`/`--no-approve` | `--no-approve` + our `worktree-trust` extension compose correctly; today we rely on that implicitly |
| **Serial queue** | `:408` `withSerialExecution`, `queued` status | Honest alternative to 8-way fan-out if concurrency causes trouble |

What does not fit: it calls `ctx.shutdown()` on settle (`:253`), so it **structurally cannot support follow-ups**; single `task` string, no agent catalog; launches by injecting a shell command with `send-keys -l` + `Enter` (`:555`, `:557`) rather than exec'ing argv; status is only `completed`/`failed` from a one-shot `result.json`.

**Hazard it inherits**: it never sets `destroy-unattached off`. A user whose `~/.tmux.conf` enables that option can have freshly detached children destroyed at birth. `RielJ/pi-git-worktrees` guards against this and so must we (see §3.7).

### 3.4 The axis that now matters: conversation lifetime

| | Our current | badlogic | mitsuhiko |
|---|---|---|---|
| Tool shape | typed, blocking, fan-out ≤8 | CLI + skill, fire-and-forget | typed, blocking, serial 1 |
| Child after turn 1 | **persists** (Herdr pane) | persists, idle | **exits** |
| Can you talk to it again | **no** | yes (`send`, steer/followUp) | **no** |
| Settlement source | Herdr `agent.get` | child writes metadata | child writes `result.json`, then exits |
| Answer transport | exact `{path, entryId}` ref | text in tool output | text in `result.json` |

We hold the persistence half and neither upstream holds the whole thing. The target is a **hybrid**: mitsuhiko's tool/transport shape, badlogic's registry + inbox, our outcome contract.

### 3.5 Parity matrix for the port

| Capability today | tmux mechanism | Verdict |
|---|---|---|
| Catalog, frontmatter, trust gating (`agents.ts`) | unchanged | free |
| Typed tool, validation, task numbering, truncation, exact answer refs | unchanged | free |
| One tab per delegation, child panes, labels | `new-session -d -s … -n <label>`, `split-window -P -F '#{pane_id}'`, `select-layout tiled` | reimplement ~150 lines |
| Unique child names with collision retry | `list-sessions -F '#{session_name}'` / `has-session` instead of `agent.list` | trivial |
| Sequential launch + concurrent observation + process-wide lock (`delegation.ts:166`) | unchanged logic; lock key becomes the tmux server/socket | free |
| Per-task timeout from confirmed launch | unchanged (`DEFAULT_TURN_TIMEOUT_MINUTES = 60`, `session.ts:91`) | free |
| Turn settlement (`agent.get` idle/working) | child hooks → atomic `state.json` | **new component, ~120 lines** |
| Session identity (`agent_session`, `PiSessionInspector.inspectHeader`) | child reports `ctx.sessionManager.getSessionId()`/`getSessionFile()` | **simpler**; header discovery dies |
| Answer extraction (`readAnswer`) | unchanged, but must become branch-aware | free + defect fix |
| Blocked state (`agent_status === "blocked"`) | translate existing `herdr:blocked` events into `state: "blocked"` | ~15 lines, reuse |
| Children never closed on timeout/abort | tmux sessions outlive the parent | free |
| `launch_indeterminate` | redefined: pane created, but the child never wrote `state.json` within N seconds | semantic change |
| Watch/take over without a command | private server + `pi --attach-subagent`, plus live pane preview in the tool result | new UX |
| Herdr `done` vs `idle` (unseen tab) | `window_activity_flag` / `monitor-activity` | lost, low value |

### 3.6 Verified Pi 1.3.0 facts (checked against the installed package)

Pi is pinned at `@earendil-works/pi-coding-agent@1.3.0`. Everything both upstreams rely on exists here:

- `pi --session <path|id>`, `--session-dir`, `--session-id`, `--append-system-prompt`, `--provider/--model/--thinking`, `--tools`, `--approve/--no-approve`, `--no-extensions`, `--extension` (`pi --help`).
- Extension events `agent_start`, `agent_before_settle`, `agent_settled` (final, notification-only), `session_start`, `session_shutdown`, `project_trust` (`docs/extensions.md:65`).
- `pi.sendUserMessage(content, { deliverAs: "steer" | "followUp" })`, `ctx.isIdle()`, `ctx.shutdown()`, `pi.setSessionName()`, `pi.getThinkingLevel()`, `pi.exec(command, args, { signal, timeout, cwd })` returning `{ stdout, stderr, code, killed }` (`dist/core/extensions/types.d.ts:1274-1300`, `:246`).
- `ctx.sessionManager` is `ReadonlySessionManager` exposing `getBranch`, `getLeafId`, `getSessionFile`, `getSessionId`, `getEntries` (`dist/core/session-manager.d.ts:178`).
- Tool definitions support `promptSnippet`, `promptGuidelines`, `renderCall`, `renderResult` (`dist/core/extensions/types.d.ts:461-518`).
- Session JSONL is an append-only **tree** via `id`/`parentId` (`docs/session-format.md:3`), with `/tree` branching and `branch_summary` entries.
- `pi.exec` accepts **no `env` option**, so child environment must be supplied in the command (`env K=V …`) or via tmux.

### 3.7 tmux hazards checklist

1. **`destroy-unattached`** — a user config that enables it kills detached children immediately. Set `destroy-unattached off` per session at creation (RielJ's fix; mitsuhiko and badlogic both miss it).
2. **Environment** — `tmux new-session` gives the child the *server's* environment. A private socket created by the parent process solves this; otherwise pass an explicit allowlist via `env`.
3. **Nested attach** — `attach-session` fails inside tmux. Fix: `--attach-subagent` re-exec that clears `TMUX`/`TMUX_PANE`, or `switch-client` when already on the same server.
4. **Pane size** — a default 80×24 pane is cramped for a Pi TUI. badlogic uses `120×40`, RielJ `200×50`. Choose explicitly.
5. **`remain-on-exit on`** — keeps a crashed child's pane inspectable and makes `#{pane_dead}` a reliable crash signal.
6. **Pane identity** — use `-P -F '#{pane_id}'` and keep the `%N` pane id; indices renumber when panes close.
7. **Session-name collision** — names are unique per server; two parent sessions can collide. Reuse the existing retry-allocate pattern from `herdr/session.ts` `buildPaneLabel`.
8. **Stale socket** — a leftover socket file makes `tmux -S <sock>` fail; detect and remove.
9. **`send-keys` injection** is the less robust launch path (the shell must be ready). Exec'ing argv after `--` avoids it; if `send-keys` is chosen, it needs a readiness check.
10. **Orphan accumulation** — detached sessions are invisible. Herdr's tabs made abandoned children visible; tmux does not. `list` + `stop` + GC become required, not optional.

### 3.8 Two defects found in current code (fix during the port, not after)

1. **`findAnswer` is branch-blind.** `pi-session.ts:183` takes the latest terminal assistant entry *in file order*. Pi sessions are trees (`docs/session-format.md:3`); after a `/tree` rewind in a child, that can return an abandoned branch's answer. Two fixes are available and they can be combined: walk the active branch leaf→root as badlogic does (`shared.ts:236`), or — better once the child bridge exists — have the child report `answerEntryId` from its own `ctx.sessionManager.getBranch()`, as mitsuhiko does (`:195`).
2. **No orphan hygiene.** See §3.7.10.

---

## 4. Bidirectional communication

### 4.1 Channels that actually exist

There is no cross-process message bus in Pi. Four channels, and nothing else:

| Direction | Channel | Reliability |
|---|---|---|
| Parent → child, live | write `<runDir>/inbox/<ts>-<rand>.json`; child extension polls and calls `pi.sendUserMessage(msg, { deliverAs })` | Good (badlogic, 250 ms). **Cannot answer a UI prompt**; if the child is blocked in `ask_user_question`, only a keypress resolves it |
| Child → parent, turn result | child writes an answer *reference* to its state file; parent polls while its tool runs | Good, and the natural fit for blocking rounds |
| Child → parent, spontaneous | child writes `<runDir>/outbox/*.json`; a **parent-side timer** injects via `pi.sendUserMessage(…, { deliverAs: "followUp" })` when `ctx.isIdle()` | Workable but intrusive; competes with the operator's turn. Needs a policy for when to interrupt |
| Child → parent, answerable question | child blocks in its TUI; parent detects `blocked`, shows the captured pane tail and the attach command | Read-only relay; a human answers it after attaching |

Two supporting observations:

- Our agent catalog already narrows the risk. `agents/docs-researcher.md` allows only `read, grep, find, ls, bash, codemode, ketch_*`, so a research child cannot block on an interactive tool, and `--tools` is already enforced at launch (`herdr/session.ts:224`). Blocking remains possible only through extension tools such as `bash-permission`.
- `ctx.shutdown()` (mitsuhiko) must **not** be borrowed. The child stays idle after settling, which is already our behaviour.

### 4.2 Proposed protocol for a follow-up round

```text
parent: read state.json → marker = current leafEntryId (or null)
        write inbox/<ts>-<rand>.json { message, delivery: "auto" }
child : polls inbox → pi.sendUserMessage(msg, { deliverAs: idle ? undefined : "steer" })
        agent_start   → state { phase: "busy", turn: n+1 }
        agent_settled → state { phase: "idle", turn: n+1,
                                leafEntryId, answerEntryId, sessionFile }
parent: wait until state.turn > recorded turn AND phase === "idle"
        resolve answerEntryId → text with readAnswer (unchanged)
```

Correlation is by **entry-id marker**, not entry count. `HazAT/pi-interactive-subagents` used counts, which `/tree` rewinds make ambiguous. This also preserves the existing invariant that answer *text* never crosses the delegation operation: the state file carries an entry id only.

Because the run directory is unique per launch, stale-state correlation is impossible by construction — better than badlogic's random `runningChildId` check and better than Herdr's pane-status correlation.

### 4.3 Handle and registry

- Durable handle per run, e.g. `sa-<8hex>`. Round 1 keeps `taskNumber` for presentation; the handle is what later calls address.
- Layout: `~/.pi/agent/subagents/<parentSessionId>/<handle>/` — parent-session scoping gives free per-session listing and GC (mitsuhiko's convention, `:467`), with badlogic's `metadata.json`.
- Fields: `{ handle, taskNumber, agent, runDir, tmuxSession, paneId, sessionFile?, stateFile, answerEntryId?, createdAt, state }`, written atomically (tmp + rename, `0600`).
- The `subagent` tool result gains one line per task: `handle sa-3f9a1c — researcher`.
- Supersede **ADR-0004** with a new ADR stating that the workspace owns subagent run state.

### 4.4 Tool surface (needs a decision, §6.3)

```text
subagent_ask    { targets: ["sa-3f9a1c", …], message, wait?: true }
                  blocks until every target settles; returns answers in order.
                  wait: false steers without blocking.
subagent_stop   { targets: […] }
subagent_list   { }                # or fold stop/list into one manage tool
```

Multiple targets give "ask all three reviewers the same follow-up" for free — the existing fan-out shape applied to round N.

### 4.5 Outcome vocabulary

Reuse `DelegatedTaskOutcome` and add one case: `blocked` (the child is waiting on UI input; include the captured pane tail and the attach command). `timed_out`, `aborted` and `session_closed` must continue to leave the child alive.

### 4.6 Optional phase 4

A parent-side ~2 s poll of live runs' state files that wakes the parent only on `blocked` or unexpected `exited`. Cheap to build; decide deliberately because it can interrupt the operator mid-turn.

---

## 5. Proposed structure and phasing

```text
packages/subagent/                 (renamed from herdr-subagent)
├── index.ts          lifecycle + tool wiring + child bridge (env-gated)
├── delegation.ts     contract types moved here from herdr/*
├── agents.ts         unchanged
├── subagent-tool.ts  unchanged except import paths + handle in result
├── pi-session.ts     keep readAnswer; drop readHeader/inspectHeader
└── tmux/
    ├── client.ts     TmuxCall seam: (args) => { status, stdout, stderr }
    ├── placement.ts  private socket, session/window/pane creation, layout
    ├── launch.ts     argv construction, unique naming, env handshake, attach
    └── observe.ts    state-file polling → DelegatedTaskOutcome
```

Test seam: a scripted `TmuxCall` mirroring the existing `HerdrRpcCall` pattern (`herdr-test-support.ts`, `herdr/rpc.test.ts`), so the 2,096 existing Herdr test lines port rather than die.

| Phase | Work | New lines |
|---|---|---|
| 0 | Move contract types out of `herdr/`; rename package; `tmux/client.ts` seam | ~120 |
| 1 | Placement (private socket, `-x 200 -y 50`, `destroy-unattached off`, `remain-on-exit on`), launch (argv + `env PI_…`), child state bridge | ~550 |
| 2 | Registry, handles in results, `subagent_ask`, `stop`/`list` | ~350 |
| 3 | `--attach-subagent` re-exec, `renderCall`/`renderResult` with pane preview | ~180 |
| 4 | Optional child→parent wake on `blocked`/`exited` | ~80 |
| 5 | Delete `herdr/`; supersede ADR-0004; update `GLOSSARY.md`; update `package.json` `pi.extensions`, `package.test.ts:41-43`, `resources.test.ts:5`, `skills-lock.json` | — |

`herdr-bridge` and `herdr-contract` survive: `bash-permission/index.ts:31,299,312` and `herdr-bridge/index.ts` keep emitting `herdr:blocked`, and the new child bridge consumes that event to write `state: "blocked"`. The rename from `herdr:*` to a neutral name is optional churn; ADR-0006 asks for a stable runtime event name, so leave it.

---

## 6. Open decisions — settle these before writing the spec

1. **Cutover**: hard switch to tmux (delete `herdr/` after parity) vs. runtime selection (`HERDR_ENV === "1"` → Herdr, else tmux) during a transition. A ten-line env branch at `index.ts:60` works either way.
2. **Placement**: mitsuhiko's private socket (recommended: no window-list pollution, enables `--attach-subagent`) vs. windows in the user's current session (closer to Herdr's always-visible model).
3. **Tool surface**: two new tools (`subagent_ask` + `subagent_stop`) vs. one `subagent_manage` with an action enum.
4. **Follow-up default**: block until the child settles (recommended for the research workflow) vs. return immediately and let the parent wait.
5. **Fan-out**: keep the existing 8-task concurrent delegation, or adopt mitsuhiko's serial queue.
6. **Launch mechanism**: `new-session -- <node> <script> …` (deterministic, no shell race, recommended) vs. `send-keys` shell injection (inherits the login shell profile).
7. **Scope**: is `subagent_ask` phase 2 of the port, or a separate follow-up change after parity is proven?

Decisions 1–4 were put to the operator and are still unanswered.

---

## 7. Suggested skills for the next agent

Load these with the Skill tool, in roughly this order:

- **`worktrunk`** — the repo requires significant work on a separate worktree. Branch `docs/herdr-to-tmux-subagents` already exists for this effort.
- **`codebase-design`** — the port introduces or renames a seam (`ExecuteDelegation`, `TmuxCall`, the child bridge). Get the deep-module vocabulary before proposing an interface, and note `AGENTS.md`'s rule that new abstractions need explicit operator approval.
- **`domain-modeling`** — *visible subagent* and *Herdr blocked event* are defined against Herdr in `GLOSSARY.md`, and ADR-0004 must be superseded. Both need recording, not silent editing.
- **`tdd`** — phase 1 is ideal test-first: the scripted `TmuxCall` and fake state files give a red-green loop without a live tmux server.
- **`web-research`** — only if a tmux primitive needs verifying against tmux 3.8 documentation. The Pi-side API surface is already verified locally (§3.6); do not re-research it.
- **`pr`** — when the spec or implementation is ready for review.

Do **not** load `herdr` — its precondition (`HERDR_ENV=1`) is false in this environment, and the goal is to stop depending on it. `HERDR_ENV` and `TMUX` are both unset here.

---

## 8. Provenance and method

- Local sources read: `packages/herdr-subagent/**` (source and tests), `packages/herdr-bridge`, `packages/herdr-contract`, `packages/bash-permission/index.ts`, `packages/worktree-trust/index.ts`, `docs/reference/*`, `docs/research/*`, `docs/adr/0004`, `docs/adr/0006`, `GLOSSARY.md`, `agents/*.md`, `package.test.ts`, `resources.test.ts`, `skills-lock.json`.
- `badlogic/pi-subagent` cloned at `4fc1fe5` (`shared.ts`, `index.ts`, `subagent.ts`, `skills/subagent/SKILL.md`, `README.md`); GitHub API confirms 238 stars, last push 2026-09-30, no licence.
- `mitsuhiko/agent-stuff/extensions/subagent.ts` fetched from `main` (687 lines).
- `RielJ/pi-git-worktrees/src/tmux-swap.ts` fetched from `main` (237 lines) for the hidden-session/`destroy-unattached` pattern.
- Pi API claims verified against the installed package at `/opt/homebrew/Cellar/pi-coding-agent/1.3.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent` (`pi --help`, `docs/*.md`, `dist/**/*.d.ts`).
- Environment: macOS, tmux 3.8, Node ≥ 22.
- No source files were modified. No secrets or personal data appear in this document or were handled during the research.
