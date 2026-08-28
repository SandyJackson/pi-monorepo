import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHerdrRpc, type HerdrRpcCall, HerdrRpcResponseError } from "./herdr/rpc.ts";
import { readSessionAnswer } from "./pi-session.ts";
import type {
  BackendSelection,
  SpawnAttempt,
  SpawnBatchOptions,
  SpawnBatchResult,
  SpawnedSubagent,
  SubagentBackend,
  SubagentInvocation,
  SubagentOutcome,
  WaitForCompletionOptions,
} from "./subagent-runner.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Poll interval for checking child pane state (milliseconds). */
const POLL_INTERVAL_MS = 800;

/**
 * Number of consecutive settled polls required before declaring completion.
 * ~1.6s stability guard against transient idle/retry-hold blips.
 */
const STABLE_SETTLED_POLLS = 2;

/** Herdr permits agent names of at most 32 ASCII slug characters. */
const PANE_LABEL_MAX_LENGTH = 32;

/** Default timeout for Herdr RPC calls (milliseconds). */
const DEFAULT_RPC_TIMEOUT = 5000;

/** Timeout for agent.start (spawn can be slower). */
const START_RPC_TIMEOUT = 15_000;

/** Maximum number of names to try when another process wins a name race. */
const MAX_NAME_ALLOCATION_ATTEMPTS = 100;

/** Maximum attempts while waiting for a newly created pane's shell prompt. */
const PANE_READINESS_RETRY_ATTEMPTS = 10;

/** Delay between retries while a newly created pane becomes startable. */
const PANE_READINESS_RETRY_DELAY_MS = 250;

/** Conservative fallback before removing a prompt file without a session signal. */
const PROMPT_CLEANUP_FALLBACK_MS = 60_000;

interface HerdrEnv {
  socketPath: string;
  paneId: string;
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Herdr RPC types
// ---------------------------------------------------------------------------

/** Minimal shape of a Herdr agent.get response relevant to us. */
interface HerdrAgentInfo {
  agent?: {
    agent_status?: string;
    agent_session?: { value?: string; path?: string };
  };
  agent_status?: string;
  agent_session?: { value?: string; path?: string };
}

/** Minimal shape of a Herdr agent.start response. */
interface HerdrStartResult {
  agent?: { pane_id?: string };
  pane_id?: string;
}

/** Minimal shapes of Herdr tab and pane responses relevant to us. */
interface HerdrTabInfo {
  tab_id?: string;
  label?: string;
}

interface HerdrPaneInfo {
  pane_id?: string;
  tab_id?: string;
}

interface HerdrTabListResult {
  tabs?: HerdrTabInfo[];
}

interface HerdrAgentListEntry {
  agent?: string;
}

interface HerdrAgentListResult {
  agents?: HerdrAgentListEntry[];
}

interface HerdrTabCreateResult {
  type?: "tab_created";
  tab?: HerdrTabInfo;
  root_pane?: HerdrPaneInfo;
}

interface HerdrPaneListResult {
  panes?: HerdrPaneInfo[];
}

interface HerdrPaneSplitResult {
  type?: "pane_info";
  pane?: HerdrPaneInfo;
}

/** The Herdr server processed agent.start and confirmed that it failed. */
class ConfirmedLaunchFailure extends Error {}

/** agent.start may have created a pane, but the client could not confirm it. */
class IndeterminateLaunchFailure extends Error {}

// ---------------------------------------------------------------------------
// Herdr backend
// ---------------------------------------------------------------------------

export class HerdrBackend implements SubagentBackend {
  /** Serializes tab provisioning within this Pi process for one Herdr workspace. */
  private static readonly subagentsTabLocks = new Map<string, Promise<void>>();

  private constructor(
    private readonly env: HerdrEnv,
    private readonly callRpc: HerdrRpcCall,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, rpcCall?: HerdrRpcCall): BackendSelection {
    if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) {
      return {
        ok: false,
        message: [
          "herdr-subagent requires this pi to run inside Herdr.",
          "HERDR_ENV, HERDR_SOCKET_PATH, and HERDR_PANE_ID must be set.",
          "Launch pi from a Herdr-managed pane, then delegate.",
        ].join(" "),
        details: { underHerdr: false },
      };
    }

    if (!env.HERDR_WORKSPACE_ID) {
      return {
        ok: false,
        message: [
          "herdr-subagent requires HERDR_WORKSPACE_ID to create or reuse the workspace subagents tab.",
          "Ensure the parent pi was launched from a Herdr-managed pane with complete Herdr environment metadata.",
        ].join(" "),
        details: { underHerdr: true, herdrEnvComplete: false },
      };
    }

    return {
      ok: true,
      backend: new HerdrBackend(
        {
          socketPath: env.HERDR_SOCKET_PATH,
          paneId: env.HERDR_PANE_ID,
          workspaceId: env.HERDR_WORKSPACE_ID,
        },
        rpcCall ?? createHerdrRpc(env.HERDR_SOCKET_PATH),
      ),
    };
  }

  async spawnBatch(
    invocations: SubagentInvocation[],
    options: SpawnBatchOptions = {},
  ): Promise<SpawnBatchResult> {
    const workspaceId = this.env.workspaceId;
    if (invocations.length === 0) return { attempts: [] };
    if (options.signal?.aborted) return { attempts: abortedAttempts(invocations) };

    const batchResult = await this.withSubagentsTabLock(workspaceId, options.signal, async () => {
      if (options.signal?.aborted) return { attempts: abortedAttempts(invocations) };

      let subagentsTab: { id: string; rootPaneId?: string; existingPaneId?: string };
      try {
        subagentsTab = await this.findOrCreateSubagentsTab(
          workspaceId,
          invocations[0].cwd,
          options.signal,
        );
      } catch (err) {
        if (options.signal?.aborted) return { attempts: abortedAttempts(invocations) };
        throw err;
      }
      const attempts: SpawnAttempt[] = [];
      let targetPaneId = subagentsTab.rootPaneId;
      let splitAnchorPaneId = subagentsTab.rootPaneId ?? subagentsTab.existingPaneId;
      let hasPlacedChild = false;

      for (let i = 0; i < invocations.length; i++) {
        if (options.signal?.aborted) {
          attempts.push(...abortedAttempts(invocations.slice(i)));
          break;
        }

        const invocation = invocations[i];
        try {
          // A new tab has one root terminal. Start the first child in that
          // terminal; only later children receive explicit splits.
          if (!targetPaneId) {
            if (!splitAnchorPaneId) throw new Error("subagents tab has no pane to split");
            targetPaneId = await this.splitPane(
              splitAnchorPaneId,
              hasPlacedChild ? "down" : "right",
              invocation.cwd,
              workspaceId,
              options.signal,
            );
            splitAnchorPaneId = targetPaneId;
          }

          const spawned = await this.spawnOne(invocation, targetPaneId, options.signal);
          attempts.push({ invocationId: invocation.invocationId, status: "spawned", spawned });
          targetPaneId = undefined;
          hasPlacedChild = true;
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          if (err instanceof IndeterminateLaunchFailure) {
            // The target may now contain a child; never try it again.
            targetPaneId = undefined;
            hasPlacedChild = true;
            attempts.push({
              invocationId: invocation.invocationId,
              status: "indeterminate",
              error,
            });
          } else {
            attempts.push({ invocationId: invocation.invocationId, status: "failed", error });
          }
        }

        if (i < invocations.length - 1) await sleep(250, options.signal);
      }

      // Never close a shared tab automatically: another Pi process may have
      // discovered or populated it after this process created it.
      return { attempts };
    });

    return batchResult ?? { attempts: abortedAttempts(invocations) };
  }

  async waitForCompletion(
    spawned: SpawnedSubagent,
    options: WaitForCompletionOptions,
  ): Promise<SubagentOutcome> {
    const deadline = Date.now() + options.timeoutMs;
    let observedActive = false;
    let stableSettled = 0;

    for (;;) {
      if (options.signal?.aborted) return { reason: "aborted" };

      let status = "unknown";
      let sessionPath: string | null = null;

      try {
        const info = (await this.callRpc(
          "agent.get",
          { target: spawned.id },
          DEFAULT_RPC_TIMEOUT,
          options.signal,
        )) as HerdrAgentInfo | undefined;
        status = info?.agent?.agent_status ?? info?.agent_status ?? "unknown";
        const raw = info?.agent?.agent_session?.value ?? info?.agent?.agent_session?.path ?? null;
        sessionPath = typeof raw === "string" && raw.length > 0 ? raw : null;
      } catch (err: unknown) {
        const msg = String(err instanceof Error ? err.message : err);
        if (
          msg.includes("not_found") ||
          msg.includes("not found") ||
          msg.includes("no such pane")
        ) {
          return {
            reason: "target_closed",
            fallbackText: `(${spawned.displayTarget} closed before completion)`,
          };
        }
        // Transient socket error — keep polling.
      }

      if (sessionPath) markPromptConsumed(spawned);

      let answerText: string | null = null;
      if ((status === "idle" || status === "done") && sessionPath) {
        answerText = readSessionAnswer(sessionPath)?.text ?? null;
      }

      const hasFinalText = answerText !== null && answerText.trim().length > 0;
      if (status === "working" || status === "blocked") {
        observedActive = true;
        stableSettled = 0;
      } else if (observedActive && (status === "idle" || status === "done")) {
        stableSettled += 1;
      } else {
        stableSettled = 0;
      }

      options.onProgress?.(
        hasFinalText
          ? `watching:${status} — ${spawned.displayTarget} (final answer captured)`
          : `watching:${status} — ${spawned.displayTarget}`,
      );

      if (observedActive && stableSettled >= STABLE_SETTLED_POLLS) {
        // Pane settled after doing work — complete with whatever we have.
        return { reason: "completed", answerText };
      }

      // Check deadline after reading the session and evaluating the completion
      // predicate so a final stable-idle poll is not reported as a timeout.
      if (Date.now() >= deadline) {
        return { reason: "timeout" };
      }

      await sleep(POLL_INTERVAL_MS, options.signal);
    }
  }

  /** Serialize tab provisioning and first-agent placement within this Pi process. */
  private async withSubagentsTabLock<T>(
    workspaceId: string,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    const key = `${this.env.socketPath}:${workspaceId}`;
    const previous = HerdrBackend.subagentsTabLocks.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      if (signal?.aborted) return undefined;
      return action();
    });
    const queueTail = result.then(
      () => undefined,
      () => undefined,
    );
    HerdrBackend.subagentsTabLocks.set(key, queueTail);
    void queueTail.finally(() => {
      if (HerdrBackend.subagentsTabLocks.get(key) === queueTail) {
        HerdrBackend.subagentsTabLocks.delete(key);
      }
    });

    return waitForLockOrAbort(result, signal);
  }

  /** Find the workspace's shared subagent tab, creating it without focusing it when absent. */
  private async findOrCreateSubagentsTab(
    workspaceId: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; rootPaneId?: string; existingPaneId?: string }> {
    const listResult = (await this.callRpc(
      "tab.list",
      { workspace_id: workspaceId },
      DEFAULT_RPC_TIMEOUT,
      signal,
    )) as HerdrTabListResult;
    const existingTab = listResult.tabs?.find(
      (tab) => isSubagentsTabLabel(tab.label) && tab.tab_id,
    );
    if (existingTab?.tab_id) {
      const existingPaneId = await this.findAnyTabPane(existingTab.tab_id, workspaceId, signal);
      return { id: existingTab.tab_id, existingPaneId };
    }

    const createResult = (await this.callRpc(
      "tab.create",
      {
        workspace_id: workspaceId,
        cwd,
        label: "subagents",
        focus: false,
      },
      DEFAULT_RPC_TIMEOUT,
      signal,
    )) as HerdrTabCreateResult;
    const tabId = createResult.tab?.tab_id;
    if (!tabId) {
      throw new Error(
        `tab.create returned no tab_id:\n${JSON.stringify(createResult).slice(0, 300)}`,
      );
    }

    const rootPaneId = createResult.root_pane?.pane_id;
    if (!rootPaneId) {
      throw new Error(
        `tab.create returned no root_pane.pane_id:\n${JSON.stringify(createResult).slice(0, 300)}`,
      );
    }
    return { id: tabId, rootPaneId };
  }

  private async findAnyTabPane(
    tabId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = (await this.callRpc(
      "pane.list",
      { workspace_id: workspaceId },
      DEFAULT_RPC_TIMEOUT,
      signal,
    )) as HerdrPaneListResult;
    const paneId = result.panes?.find((pane) => pane.tab_id === tabId)?.pane_id;
    if (!paneId) throw new Error(`subagents tab ${tabId} has no root pane`);
    return paneId;
  }

  private async splitPane(
    targetPaneId: string,
    direction: "right" | "down",
    cwd: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = (await this.callRpc(
      "pane.split",
      { target_pane_id: targetPaneId, direction, cwd, workspace_id: workspaceId, focus: false },
      DEFAULT_RPC_TIMEOUT,
      signal,
    )) as HerdrPaneSplitResult;
    const paneId = result.type === "pane_info" ? result.pane?.pane_id : undefined;
    if (!paneId)
      throw new Error(
        `pane.split returned no new pane id:\n${JSON.stringify(result).slice(0, 300)}`,
      );
    return paneId;
  }

  private async listAgentNames(signal?: AbortSignal): Promise<Set<string>> {
    const result = (await this.callRpc(
      "agent.list",
      {},
      DEFAULT_RPC_TIMEOUT,
      signal,
    )) as HerdrAgentListResult;
    if (!Array.isArray(result.agents)) {
      throw new Error(
        `agent.list returned no agents array:\n${JSON.stringify(result).slice(0, 300)}`,
      );
    }
    return new Set(
      result.agents
        .map((entry) => entry.agent?.trim())
        .filter((name): name is string => Boolean(name)),
    );
  }

  private async spawnOne(
    invocation: SubagentInvocation,
    targetPaneId: string,
    signal?: AbortSignal,
  ): Promise<SpawnedSubagent> {
    const occupiedNames = await this.listAgentNames(signal);
    let ordinal = 1;
    const argv: string[] = [];
    let cleanupPrompt: (() => void) | undefined;
    let promptConsumed = true;

    if (invocation.config.model) argv.push("--model", invocation.config.model);
    if (invocation.config.tools !== undefined && invocation.config.tools.length > 0) {
      argv.push("--tools", invocation.config.tools.join(","));
    }

    if (invocation.config.systemPromptBody) {
      promptConsumed = false;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
      const tmpPath = path.join(tmpDir, "system-prompt.md");
      cleanupPrompt = () => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore cleanup failures */
        }
      };
      try {
        fs.writeFileSync(tmpPath, invocation.config.systemPromptBody, "utf-8");
      } catch (err) {
        cleanupPrompt();
        throw err;
      }
      argv.push("--append-system-prompt", tmpPath);
    }
    argv.push(sanitizeArgForHerdr(invocation.task));

    let label = "";
    let paneId: string | null = null;
    for (let attempt = 0; attempt < MAX_NAME_ALLOCATION_ATTEMPTS; attempt++, ordinal++) {
      label = buildPaneLabel(invocation.agentName, invocation.task, ordinal);
      if (occupiedNames.has(label)) continue;

      const startParams: Record<string, unknown> = {
        name: label,
        kind: "pi",
        pane_id: targetPaneId,
        args: ["--name", label, ...argv],
      };

      let raw: unknown;
      try {
        raw = await retryWithDelay(
          () => this.callRpc("agent.start", startParams, START_RPC_TIMEOUT, signal),
          isTransientPaneReadinessError,
          {
            maxAttempts: PANE_READINESS_RETRY_ATTEMPTS,
            delayMs: PANE_READINESS_RETRY_DELAY_MS,
            signal,
          },
        );
      } catch (err: unknown) {
        if (err instanceof HerdrRpcResponseError) {
          if (err.code === "agent_name_taken") {
            occupiedNames.add(label);
            continue;
          }
          cleanupPrompt?.();
          throw new ConfirmedLaunchFailure(err.message);
        }
        // A transport or ambiguous server failure can occur after Herdr has
        // created the pane. Retain prompt resources for a conservative fallback.
        scheduleCleanup(cleanupPrompt);
        throw new IndeterminateLaunchFailure(err instanceof Error ? err.message : String(err));
      }

      const startResult = raw as HerdrStartResult | null;
      paneId = startResult?.agent?.pane_id ?? startResult?.pane_id ?? null;
      if (!paneId) {
        scheduleCleanup(cleanupPrompt);
        throw new IndeterminateLaunchFailure(
          `agent.start returned no pane_id:\n${JSON.stringify(startResult).slice(0, 300)}`,
        );
      }
      break;
    }

    if (!paneId) {
      cleanupPrompt?.();
      throw new ConfirmedLaunchFailure(
        `could not allocate a unique Herdr agent name after ${MAX_NAME_ALLOCATION_ATTEMPTS} attempts`,
      );
    }

    let cleaned = false;
    let cleanupRequested = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseResources = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(fallbackTimer);
      cleanupPrompt?.();
    };
    const requestCleanup = () => {
      cleanupRequested = true;
      if (promptConsumed) {
        releaseResources();
        return;
      }
      if (!fallbackTimer) {
        fallbackTimer = setTimeout(releaseResources, PROMPT_CLEANUP_FALLBACK_MS);
        fallbackTimer.unref?.();
      }
    };
    const spawned: SpawnedSubagent & { markPromptConsumed(): void } = {
      id: paneId,
      displayTarget: `pane ${paneId}`,
      label,
      markPromptConsumed: () => {
        promptConsumed = true;
        if (cleanupRequested) releaseResources();
      },
      cleanup: requestCleanup,
    };

    return spawned;
  }
}

/** Return early on cancellation without breaking the lock's queued successor chain. */
function waitForLockOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

interface RetryWithDelayOptions {
  maxAttempts: number;
  delayMs: number;
  signal?: AbortSignal;
}

/** Retry an operation only for errors explicitly identified as transient. */
async function retryWithDelay<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  options: RetryWithDelayOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= options.maxAttempts || !shouldRetry(error)) throw error;
      await sleep(options.delayMs, options.signal, false);
    }
  }
}

/** Return true when a newly created pane may not have its shell prompt yet. */
function isTransientPaneReadinessError(error: unknown): boolean {
  return (
    error instanceof HerdrRpcResponseError &&
    (error.code === "agent_pane_busy" || error.code === "agent_pane_unavailable")
  );
}

/** Retain prompt files briefly when a launch may have succeeded without a response. */
function scheduleCleanup(cleanup: (() => void) | undefined): void {
  if (!cleanup) return;
  const timer = setTimeout(cleanup, PROMPT_CLEANUP_FALLBACK_MS);
  timer.unref?.();
}

/** Build terminal not-started attempts after an abort without losing task identity. */
function abortedAttempts(invocations: SubagentInvocation[]): SpawnAttempt[] {
  return invocations.map((invocation) => ({
    invocationId: invocation.invocationId,
    status: "not_started" as const,
    reason: "aborted" as const,
    error: "delegation was aborted before this subagent launched",
  }));
}

/** Prompt files may be removed only after Pi has published a session reference. */
function markPromptConsumed(spawned: SpawnedSubagent): void {
  spawned.markPromptConsumed?.();
}

/** Herdr 0.7 displays numbered tab labels as, for example, "[4] subagents". */
function isSubagentsTabLabel(label: string | undefined): boolean {
  return label === "subagents" || /^\[\d+\] subagents$/.test(label ?? "");
}

/**
 * Sanitize a string for use as a Herdr agent argument.
 * Herdr rejects arguments containing control characters (newlines, tabs, etc.).
 * This replaces control characters with spaces to preserve readability.
 */
function sanitizeArgForHerdr(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control characters
  return value.replace(/[\x00-\x1f\x7f]/g, " ");
}

// ---------------------------------------------------------------------------
// Pane naming
// ---------------------------------------------------------------------------

/** Build the shared Pi pane label and Herdr agent name. */
function buildPaneLabel(agentName: string, task: string, ordinal = 1): string {
  const prefix = "sa-";
  const suffix = ordinal > 1 ? `-${ordinal}` : "";
  const readableSlug = `${agentName}-${task}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const availableReadableLength = PANE_LABEL_MAX_LENGTH - prefix.length - suffix.length;
  const readable =
    (readableSlug || "agent").slice(0, Math.max(1, availableReadableLength)).replace(/-+$/, "") ||
    "agent";
  return `${prefix}${readable}${suffix}`.slice(0, PANE_LABEL_MAX_LENGTH);
}

/** Resolve after `ms` milliseconds, abortable via `signal`. */
function sleep(ms: number, signal?: AbortSignal, unrefTimer = true): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    timer = setTimeout(finish, ms);
    if (unrefTimer) timer.unref?.();

    if (signal?.aborted) {
      finish();
      return;
    }

    signal?.addEventListener("abort", finish, { once: true });
  });
}
