import type { HerdrRpcCall } from "./rpc.ts";
import { createHerdrRpc } from "./rpc.ts";
import {
  DEFAULT_RPC_TIMEOUT,
  DEFAULT_TURN_TIMEOUT_MS,
  type DelegatedTask,
  type DelegatedTaskOutcome,
  launchDelegatedTask,
  type ObserveTurnOptions,
  sleep,
  type VisibleSubagentSessionRef,
} from "./session.ts";

// ---------------------------------------------------------------------------
// Types — numbered task records and total ordered outcomes
// ---------------------------------------------------------------------------

/** A delegated task carrying its canonical one-based delegation-scoped number. */
export type DelegatedTaskRecord = DelegatedTask & { taskNumber: number };

/** The single terminal outcome of one delegated task, paired with its record. */
export interface DelegatedTaskExecution {
  task: DelegatedTaskRecord;
  outcome: DelegatedTaskOutcome;
}

/** The injected Herdr runtime context used by the delegation operation. */
export interface HerdrDelegationContext {
  rpc: HerdrRpcCall;
  workspaceId: string;
}

export interface HerdrDelegationOptions extends HerdrDelegationContext {
  /** Per-task timeout, starting at each task's confirmed launch. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (update: { taskNumber: number; line: string }) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of valid delegated tasks per delegation. */
export const MAX_DELEGATED_TASKS = 8;

const INTER_LAUNCH_PAUSE_MS = 250;

// ---------------------------------------------------------------------------
// Environment — the only place that validates the Herdr runtime environment
// ---------------------------------------------------------------------------

/**
 * Validate the Herdr environment and build the delegation runtime context.
 *
 * Throws before any child launch when this Pi was not started from a
 * Herdr-managed pane with complete workspace metadata.
 */
export function herdrDelegationEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): HerdrDelegationContext {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH) {
    throw new Error(
      [
        "herdr-subagent requires this pi to run inside Herdr.",
        "HERDR_ENV and HERDR_SOCKET_PATH must be set.",
        "Launch pi from a Herdr-managed pane, then delegate.",
      ].join(" "),
    );
  }

  if (!env.HERDR_WORKSPACE_ID) {
    throw new Error(
      [
        "herdr-subagent requires HERDR_WORKSPACE_ID to create or reuse the workspace subagents tab.",
        "Ensure the parent pi was launched from a Herdr-managed pane with complete Herdr environment metadata.",
      ].join(" "),
    );
  }

  return {
    rpc: createHerdrRpc(env.HERDR_SOCKET_PATH),
    workspaceId: env.HERDR_WORKSPACE_ID,
  };
}

// ---------------------------------------------------------------------------
// Workspace placement
// ---------------------------------------------------------------------------

interface SubagentsTab {
  /** Root pane of a tab this operation created, for the first child. */
  rootPaneId?: string;
  /** Any pane of a tab discovered in the workspace, for the first split. */
  existingPaneId?: string;
}

interface HerdrTabInfo {
  tab_id?: string;
  label?: string;
}

interface HerdrPaneInfo {
  pane_id?: string;
  tab_id?: string;
}

/**
 * Find the workspace's shared subagent tab, creating it without focusing it
 * when absent.
 */
async function findOrCreateSubagentsTab(
  rpc: HerdrRpcCall,
  workspaceId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<SubagentsTab> {
  const listResult = (await rpc(
    "tab.list",
    { workspace_id: workspaceId },
    DEFAULT_RPC_TIMEOUT,
    signal,
  )) as { tabs?: HerdrTabInfo[] };
  const existingTab = listResult.tabs?.find((tab) => isSubagentsTabLabel(tab.label) && tab.tab_id);
  if (existingTab?.tab_id) {
    const existingPaneId = await findAnyTabPane(rpc, existingTab.tab_id, workspaceId, signal);
    return { existingPaneId };
  }

  const createResult = (await rpc(
    "tab.create",
    {
      workspace_id: workspaceId,
      cwd,
      label: "subagents",
      focus: false,
    },
    DEFAULT_RPC_TIMEOUT,
    signal,
  )) as { tab?: HerdrTabInfo; root_pane?: HerdrPaneInfo };
  const rootPaneId = createResult.root_pane?.pane_id;
  if (!createResult.tab?.tab_id) {
    throw new Error(
      `tab.create returned no tab_id:\n${JSON.stringify(createResult).slice(0, 300)}`,
    );
  }
  if (!rootPaneId) {
    throw new Error(
      `tab.create returned no root_pane.pane_id:\n${JSON.stringify(createResult).slice(0, 300)}`,
    );
  }
  return { rootPaneId };
}

const workspaceLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize shared tab provisioning and child pane placement across this Pi
 * process for one Herdr workspace.
 *
 * The lock covers only provisioning and sequential launches; it never waits
 * for child turns to settle. A queued delegation that is cancelled while
 * waiting still acquires the lock briefly and returns without acting; aborts
 * during the launch loop itself are handled positionally by the loop.
 */
function withWorkspaceLock<T>(
  workspaceId: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T | undefined> {
  const previous = workspaceLocks.get(workspaceId) ?? Promise.resolve();
  const result = previous.then(async () => {
    if (signal?.aborted) return undefined;
    return action();
  });
  const tail = result.catch(() => {});
  workspaceLocks.set(workspaceId, tail);
  void tail.finally(() => {
    if (workspaceLocks.get(workspaceId) === tail) workspaceLocks.delete(workspaceId);
  });

  return result;
}

async function findAnyTabPane(
  rpc: HerdrRpcCall,
  tabId: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = (await rpc(
    "pane.list",
    { workspace_id: workspaceId },
    DEFAULT_RPC_TIMEOUT,
    signal,
  )) as { panes?: HerdrPaneInfo[] };
  const paneId = result.panes?.find((pane) => pane.tab_id === tabId)?.pane_id;
  if (!paneId) throw new Error(`subagents tab ${tabId} has no root pane`);
  return paneId;
}

async function splitPane(
  rpc: HerdrRpcCall,
  targetPaneId: string,
  direction: "right" | "down",
  cwd: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = (await rpc(
    "pane.split",
    { target_pane_id: targetPaneId, direction, cwd, workspace_id: workspaceId, focus: false },
    DEFAULT_RPC_TIMEOUT,
    signal,
  )) as { type?: "pane_info"; pane?: HerdrPaneInfo };
  const paneId = result.type === "pane_info" ? result.pane?.pane_id : undefined;
  if (!paneId)
    throw new Error(`pane.split returned no new pane id:\n${JSON.stringify(result).slice(0, 300)}`);
  return paneId;
}

/** Herdr 0.7 displays numbered tab labels as, for example, "[4] subagents". */
function isSubagentsTabLabel(label: string | undefined): boolean {
  return label === "subagents" || /^\[\d+\] subagents$/.test(label ?? "");
}

// ---------------------------------------------------------------------------
// Ordered delegation operation
// ---------------------------------------------------------------------------

/**
 * Execute numbered delegated tasks as one ordered delegation operation.
 *
 * Every input record receives exactly one outcome, returned in the input
 * order carrying the same task record and number. Shared Herdr environment
 * and workspace failures throw before any launch; once task-specific launch
 * processing begins, expected operational failures become positional
 * outcomes.
 */
export async function executeHerdrDelegation(
  tasks: readonly DelegatedTaskRecord[],
  options: HerdrDelegationOptions,
): Promise<DelegatedTaskExecution[]> {
  if (tasks.length > MAX_DELEGATED_TASKS) {
    throw new Error(`Too many delegated tasks (${tasks.length}). Max is ${MAX_DELEGATED_TASKS}.`);
  }
  if (tasks.length === 0) return [];

  const { rpc, workspaceId, signal, onProgress } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

  if (signal?.aborted) return abortedBeforeLaunch(tasks);

  const pendingObservations: Promise<void>[] = [];
  const outcomes: Array<DelegatedTaskOutcome | undefined> = new Array(tasks.length);

  const lockResult = await withWorkspaceLock(workspaceId, signal, async () => {
    if (signal?.aborted) return undefined;

    let tab: SubagentsTab;
    try {
      tab = await findOrCreateSubagentsTab(rpc, workspaceId, tasks[0].cwd, signal);
    } catch (err) {
      if (signal?.aborted) return undefined;
      throw err;
    }

    // A new tab has one root terminal: the first child starts there; only
    // later children receive explicit splits. In an existing tab every child
    // splits, first right then down. A pane created for one task's cwd may
    // only be reused by a sibling with the same cwd.
    let targetPaneId = tab.rootPaneId;
    let targetPaneCwd = tab.rootPaneId ? tasks[0].cwd : undefined;
    let splitAnchorPaneId = tab.rootPaneId ?? tab.existingPaneId;
    let hasPlacedChild = false;

    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      if (signal?.aborted) {
        markRemainingAborted(index);
        return true;
      }

      if (!targetPaneId || targetPaneCwd !== task.cwd) {
        if (!splitAnchorPaneId) {
          outcomes[index] = {
            status: "launch_failed",
            error: "subagents tab has no pane to split",
          };
          continue;
        }
        try {
          targetPaneId = await splitPane(
            rpc,
            splitAnchorPaneId,
            hasPlacedChild ? "down" : "right",
            task.cwd,
            workspaceId,
            signal,
          );
          targetPaneCwd = task.cwd;
          splitAnchorPaneId = targetPaneId;
        } catch (err: unknown) {
          if (signal?.aborted) {
            markRemainingAborted(index);
            return true;
          }
          outcomes[index] = {
            status: "launch_failed",
            error: err instanceof Error ? err.message : String(err),
          };
          continue;
        }
      }

      const launch = await launchDelegatedTask({ rpc, targetPaneId, task, signal });
      if (launch.status === "launched") {
        startObservation(index, task.taskNumber, launch.session, launch.observeTurn);
      } else {
        outcomes[index] = launch;
      }
      // A launched (or possibly launched) task occupies the pane; only a
      // confirmed failure leaves it free for a same-cwd sibling to reuse.
      if (launch.status !== "launch_failed") {
        targetPaneId = undefined;
        targetPaneCwd = undefined;
        hasPlacedChild = true;
      }

      if (index < tasks.length - 1) await sleep(INTER_LAUNCH_PAUSE_MS, signal);
    }

    return true;
  });

  if (!lockResult) return abortedBeforeLaunch(tasks);

  // Observations were started during launch; wait for them without holding
  // the workspace lock and without closing any timed-out or aborted session.
  await Promise.all(pendingObservations);

  // Verify the total ordered contract: exactly one outcome per record.
  return tasks.map((task, index) => {
    const outcome = outcomes[index];
    if (!outcome) {
      throw new Error(`delegation produced no outcome for task ${task.taskNumber}`);
    }
    return { task, outcome };
  });

  function startObservation(
    index: number,
    taskNumber: number,
    session: VisibleSubagentSessionRef,
    observeTurn: (observeOptions?: ObserveTurnOptions) => Promise<DelegatedTaskOutcome>,
  ): void {
    // Attach rejection handling before the next launch: observation is
    // expected to resolve with an outcome, but a defect must not reject the
    // whole delegation.
    const promise = observeTurn({
      timeoutMs,
      signal,
      onProgress: (line) => onProgress?.({ taskNumber, line }),
    })
      .then((outcome) => {
        outcomes[index] = outcome;
      })
      .catch((err: unknown) => {
        outcomes[index] = {
          status: "observation_failed",
          session,
          error: err instanceof Error ? err.message : String(err),
        };
      });
    pendingObservations.push(promise);
  }

  function markRemainingAborted(fromIndex: number): void {
    for (let index = fromIndex; index < tasks.length; index++) {
      outcomes[index] = { status: "aborted", stage: "before_launch" };
    }
  }
}

/** Abort every task that never launched; no session exists to close. */
function abortedBeforeLaunch(tasks: readonly DelegatedTaskRecord[]): DelegatedTaskExecution[] {
  return tasks.map((task) => ({
    task,
    outcome: { status: "aborted", stage: "before_launch" },
  }));
}
