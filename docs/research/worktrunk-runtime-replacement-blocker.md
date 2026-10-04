# Worktrunk runtime replacement blocker

Status: unresolved upstream dependency for parent issue #14. The user chose to record the blocker rather than change Pi core or weaken the requirement.

## Finding

The parent review in `state.json` is valid. On the installed Pi 0.81.1, target-runtime creation failure after source teardown exits the interactive process. The Worktrunk extension cannot catch or recover from that exit through the public extension API.

The prepared target file and persisted source file are retained, but the source runtime is disposed and the interactive session is no longer usable. Retaining files does not satisfy the requirement to report extension failures without stranding Pi.

## Verified path

Paths below are relative to `node_modules/@earendil-works/pi-coding-agent/dist/`:

- `core/agent-session-runtime.js`, `AgentSessionRuntime.switchSession()`: opens and checks the target session, calls `teardownCurrent()`, then calls `createRuntime()`. `teardownCurrent()` disposes the source session. There is no rollback if target creation fails.
- `modes/interactive/interactive-mode.js`, the extension `switchSession` action: delegates to `handleResumeSession()`.
- `handleResumeSession()`: catches ordinary runtime-replacement errors and calls `handleFatalRuntimeError()`.
- `handleFatalRuntimeError()`: shows a host error, stops the UI, and calls `process.exit(1)`.
- `packages/worktrunk/index.ts`, `createSwitchExecutor()`: its captured UI and catch block do not get control back from this fatal path.

The `createSwitchExecutor` rejection mocks in `packages/worktrunk/worktrunk.test.ts` test notification routing for rejecting hosts. They do not establish recovery from the interactive host's fatal path.

## Reproduction

A temporary harness exercised the real `AgentSessionRuntime.switchSession()`, `InteractiveMode.handleResumeSession()`, `InteractiveMode.handleFatalRuntimeError()`, and Worktrunk `createSwitchExecutor()` in a child process. It supplied a valid target session file, a minimal source session, and a runtime factory that threw after source disposal. Terminal rendering was replaced with trace output; `process.exit()` was not mocked.

Command run from the checkout:

```sh
pnpm exec jiti /tmp/wt-fatal-runtime-repro.ts "$PWD"
```

Observed output:

```text
SOURCE_DISPOSED
TARGET_CREATION_FAILED
HOST_ERROR Failed to resume session: target runtime could not be created
UI_STOPPED
```

The process exited with status 1. Neither `EXTENSION_NOTIFICATION`, `WITH_SESSION`, nor `EXTENSION_RETURNED` appeared. The temporary target file was cleaned up on process exit.

## Approved gate semantics

The busy/dirty gates intentionally differ from the stored ticket's literal cancellation wording. An approved abort completes before dirty state is read, so final writes are included in the confirmation. Declining that confirmation prevents Worktrunk switching and session relocation but does not undo the approved abort. Cancellation of the busy dialog does not abort the run.

If a new run is detected during later awaits, relocation stops without aborting it. Worktrunk hooks already in progress are allowed to finish; Pi remains in the source session.

## Required upstream work

Pi needs recoverable runtime replacement that preserves or restores a usable source runtime when target creation fails. The interactive host must distinguish recoverable failures from fatal failures and report them without exiting. Simply changing the host to reject is insufficient when the source runtime has already been disposed.

Regression coverage must exercise the real runtime and interactive-host failure path, assert that Pi remains usable, and verify retention of source and prepared target files. The deployed Pi executable must contain that fix; patching this workspace's development dependency alone does not update the host loading the extension.

Until that upstream behavior is available and verified, the parent acceptance requirement remains unmet. No extension workaround or passing mock test should be reported as resolving it. `state.json` remains unchanged.
