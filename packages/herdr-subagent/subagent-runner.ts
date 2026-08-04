/**
 * subagent-runner.ts — backend-neutral sub-agent runner.
 *
 * Owns tool-execution behaviour: validation, agent resolution, orchestration,
 * progress updates, result ordering, and result formatting.
 *
 * The runner knows nothing about Herdr. It defines the SubagentBackend port
 * that backends (Herdr, future tmux) implement.
 *
 * The entrypoint (index.ts) derives RunnerOptions from Pi context/session
 * state and calls {@link runSubagents}.
 */

import type { AgentConfig, AgentScope } from "./agents.ts";
import {
	discoverUserAgents,
	discoverProjectAgents,
	formatMergedAgentList,
	mergeAgentLists,
	resolveAgent,
} from "./agents.ts";
// ---------------------------------------------------------------------------
// Backend interface — the port that backends implement.
// ---------------------------------------------------------------------------

/** A single delegation invocation to be spawned by a backend. */
export interface SubagentInvocation {
	/** Opaque invocation id provided by the runner — used for result correlation. */
	invocationId: string;
	agentName: string;
	task: string;
	cwd: string;
	config: AgentConfig;
}

/** A spawned sub-agent target, returned by a backend after successful spawn. */
export interface SpawnedSubagent {
	/** Opaque backend target id (e.g. Herdr pane id). */
	id: string;
	/** Human-readable target reference for messages (e.g. "pane 42"). */
	displayTarget: string;
	/** Human-readable child session label. */
	label: string;
	/**
	 * Idempotently clean up local spawn resources once the backend considers it safe.
	 * Must not close the child pane.
	 */
	cleanup(): void;
	markPromptConsumed?(): void;
}

/** The outcome of waiting for a sub-agent to complete. */
export type SubagentOutcome =
	| { reason: "completed"; answerText: string | null }
	| { reason: "target_closed"; fallbackText: string }
	| { reason: "aborted" }
	| { reason: "timeout" };

/** Options passed to {@link SubagentBackend.waitForCompletion}. */
export interface WaitForCompletionOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?: (statusLine: string) => void;
}

/**
 * Backend abstraction for visible sub-agent runtimes.
 *
 * Implementations (HerdrBackend, future TmuxBackend) handle environment
 * validation, spawn, polling, and cleanup specific to their runtime.
 */
export interface SpawnBatchOptions {
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Backend batch result types
// ---------------------------------------------------------------------------

/**
 * Outcome of a single child-launch attempt within a batch.
 *
 * Every requested invocationId must be accounted for exactly once in
 * the returned SpawnBatchResult, regardless of whether the child
 * launched successfully or not.
 */
export type SpawnAttempt =
	| {
			invocationId: string;
			status: "spawned";
			spawned: SpawnedSubagent;
	  }
	| {
			/** The backend confirmed that this invocation did not launch a child. */
			invocationId: string;
			status: "failed";
			error: string;
	  }
	| {
			/** This invocation was deliberately not launched. */
			invocationId: string;
			status: "not_started";
			reason: "aborted" | "catastrophic";
			error: string;
	  }
	| {
			/** Herdr may have launched a child, but the client could not confirm it. */
			invocationId: string;
			status: "indeterminate";
			error: string;
	  };

/** Structured result of a backend spawnBatch call. */
export interface SpawnBatchResult {
	attempts: SpawnAttempt[];
}

export interface SubagentBackend {
	spawnBatch(invocations: SubagentInvocation[], options?: SpawnBatchOptions): Promise<SpawnBatchResult>;
	waitForCompletion(
		spawned: SpawnedSubagent,
		options: WaitForCompletionOptions,
	): Promise<SubagentOutcome>;
}

/** Result of backend auto-detection. */
export type BackendSelection =
	| { ok: true; backend: SubagentBackend }
	| { ok: false; message: string; details: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Runner options — derived by the entrypoint from Pi context
// ---------------------------------------------------------------------------

/**
 * Runtime options for the sub-agent runner.
 *
 * These are derived from Pi context and session state before being passed
 * to the runner, so the runner does not need to import Pi SDK types.
 */
export interface RunnerOptions {
	/** The parent session's working directory. */
	parentCwd: string;
	/**
	 * Whether project-local agents should be included.
	 * Derived from Pi project trust.
	 */
	includeProjectAgents: boolean;
	/**
	 * Backend auto-detection function.
	 * Called only when tasks actually need to spawn.
	 */
	detectAutoBackend: () => BackendSelection;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-task output cap (50 KiB). */
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Default delegation timeout in minutes. */
const DEFAULT_TIMEOUT_MINUTES = 20;

/** Max parallel tasks. */
const MAX_PARALLEL_TASKS = 8;

/** Max concurrent agent waits in parallel mode. */
const MAX_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type BatchValidation =
	| { ok: true; attemptsById: Map<string, SpawnAttempt> }
	| { ok: false; details: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSpawnedSubagent(value: unknown): value is SpawnedSubagent {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.displayTarget === "string" &&
		typeof value.label === "string" &&
		typeof value.cleanup === "function"
	);
}

function parseSpawnAttempt(value: unknown): SpawnAttempt | null {
	if (!isRecord(value) || typeof value.invocationId !== "string" || typeof value.status !== "string") {
		return null;
	}

	switch (value.status) {
		case "spawned":
			return isSpawnedSubagent(value.spawned)
				? { invocationId: value.invocationId, status: "spawned", spawned: value.spawned }
				: null;
		case "failed":
			return typeof value.error === "string"
				? { invocationId: value.invocationId, status: "failed", error: value.error }
				: null;
		case "not_started":
			return (value.reason === "aborted" || value.reason === "catastrophic") && typeof value.error === "string"
				? {
						invocationId: value.invocationId,
						status: "not_started",
						reason: value.reason,
						error: value.error,
					}
				: null;
		case "indeterminate":
			return typeof value.error === "string"
				? { invocationId: value.invocationId, status: "indeterminate", error: value.error }
				: null;
		default:
			return null;
	}
}

/**
 * Validate runtime backend output before it can affect task accounting.
 * A valid result contains one well-formed attempt for every requested ID.
 */
function validateBatchResult(requestedIds: string[], result: unknown): BatchValidation {
	if (!isRecord(result) || !Array.isArray(result.attempts)) {
		return { ok: false, details: { reason: "result_missing_attempts", requestedIds } };
	}

	const attemptsById = new Map<string, SpawnAttempt>();
	for (let index = 0; index < result.attempts.length; index++) {
		const attempt = parseSpawnAttempt(result.attempts[index]);
		if (!attempt) {
			return { ok: false, details: { reason: "invalid_attempt", index, requestedIds } };
		}
		if (!requestedIds.includes(attempt.invocationId)) {
			return {
				ok: false,
				details: { reason: "unknown_invocation", invocationId: attempt.invocationId, requestedIds },
			};
		}
		if (attemptsById.has(attempt.invocationId)) {
			return {
				ok: false,
				details: { reason: "duplicate_invocation", invocationId: attempt.invocationId, requestedIds },
			};
		}
		attemptsById.set(attempt.invocationId, attempt);
	}

	const missingIds = requestedIds.filter((id) => !attemptsById.has(id));
	if (missingIds.length > 0) {
		return { ok: false, details: { reason: "missing_invocations", missingIds, requestedIds } };
	}

	return { ok: true, attemptsById };
}

/** Best-effort local cleanup that cannot replace a terminal task outcome. */
function cleanupSpawned(spawned: SpawnedSubagent): string | null {
	try {
		spawned.cleanup();
		return null;
	} catch (err: unknown) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** Best-effort local cleanup for any launched children in malformed backend output. */
function cleanupSpawnedAttempts(result: unknown): string[] {
	if (!isRecord(result) || !Array.isArray(result.attempts)) return [];

	const spawnedChildren = new Set<SpawnedSubagent>();
	for (const value of result.attempts) {
		if (!isRecord(value) || !isSpawnedSubagent(value.spawned)) continue;
		spawnedChildren.add(value.spawned);
	}
	return [...spawnedChildren]
		.map((spawned) => cleanupSpawned(spawned))
		.filter((error): error is string => error !== null);
}

/** Agent scope derived from includeProjectAgents (internal policy). */
const USER_SCOPE: AgentScope = "user";
const BOTH_SCOPE: AgentScope = "both";

function internalScope(includeProjectAgents: boolean): AgentScope {
	return includeProjectAgents ? BOTH_SCOPE : USER_SCOPE;
}

/** Resolved task info (after agent resolution). */
interface ResolvedTask {
	/** Stable invocation id used for backend result correlation. */
	invocationId: string;
	/** Original index in the user-requested task order — preserves output ordering. */
	index: number;
	agent: string;
	task: string;
	cwd: string;
	config: AgentConfig;
}

/**
 * List known legacy parameter keys that should trigger a "use tasks array" error.
 * These are top-level params from the old API shape that are no longer valid.
 */
const LEGACY_KEYS = new Set(["agent", "task", "chain", "cwd", "agentScope", "confirmProjectAgents"]);

/**
 * Check whether the params contain any legacy keys from the old API.
 * Returns the first legacy key found, or null if none.
 */
function detectLegacyParams(params: Record<string, unknown>): string | null {
	for (const key of LEGACY_KEYS) {
		if (key in params) return key;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Result formatting helpers
// ---------------------------------------------------------------------------

interface FormattedOutcome {
	text: string;
	success: boolean;
	details: Record<string, unknown>;
}

function capOutput(text: string): string {
	if (text.length <= PER_TASK_OUTPUT_CAP) return text;
	return (
		text.slice(0, PER_TASK_OUTPUT_CAP) +
		`\n…[truncated ${text.length - PER_TASK_OUTPUT_CAP} chars]`
	);
}

function formatOutcome(
	outcome: SubagentOutcome,
	displayTarget: string,
	timeoutMinutes: number,
): FormattedOutcome {
	switch (outcome.reason) {
		case "completed":
			return {
				text:
					outcome.answerText && outcome.answerText.trim().length > 0
						? capOutput(outcome.answerText)
						: `subagent produced no final answer; inspect ${displayTarget}`,
				success: true,
				details: {},
			};

		case "timeout":
			return {
				text: `delegation timed out after ${timeoutMinutes}m, ${displayTarget} still live`,
				success: false,
				details: { timeout: true },
			};

		case "aborted":
			return {
				text: `Subagent aborted. ${displayTarget} is still running.`,
				success: false,
				details: { aborted: true },
			};

		case "target_closed":
			return {
				text: outcome.fallbackText,
				success: false,
				details: {},
			};
	}
}

/** Format a single-agent result for the model. */
function formatSingleResult(
	agentName: string,
	outcome: SubagentOutcome,
	spawned: SpawnedSubagent,
	timeoutMinutes: number,
): { text: string; details: Record<string, unknown> } {
	const formattedOutcome = formatOutcome(outcome, spawned.displayTarget, timeoutMinutes);
	return {
		text: formattedOutcome.text,
		details: {
			mode: "single",
			targetId: spawned.id,
			target: spawned.displayTarget,
			agent: agentName,
			...formattedOutcome.details,
		},
	};
}

/** A single task result in a parallel delegation run. */
interface ParallelResult {
	invocationId: string;
	agent: string;
	targetId: string;
	text: string;
	success: boolean;
	details: Record<string, unknown>;
}

function notStartedResult(
	task: ResolvedTask,
	reason: "aborted" | "catastrophic",
	error: string,
): ParallelResult {
	return {
		invocationId: task.invocationId,
		agent: task.agent,
		targetId: "",
		text: `not started — ${error}`,
		success: false,
		details: { spawnStatus: "not_started", reason, error },
	};
}

function attemptFailureResult(task: ResolvedTask, attempt: Exclude<SpawnAttempt, { status: "spawned" }>): ParallelResult {
	switch (attempt.status) {
		case "failed":
			return {
				invocationId: task.invocationId,
				agent: task.agent,
				targetId: "",
				text: `spawn failed: ${attempt.error}`,
				success: false,
				details: { spawnStatus: attempt.status, error: attempt.error },
			};
		case "not_started":
			return notStartedResult(task, attempt.reason, attempt.error);
		case "indeterminate":
			return {
				invocationId: task.invocationId,
				agent: task.agent,
				targetId: "",
				text: "subagent launch state is unknown; inspect the subagents tab.",
				success: false,
				details: { spawnStatus: attempt.status, error: attempt.error },
			};
	}
}

/** Format parallel task results for the model. */
function formatParallelResults(
	results: ParallelResult[],
): string {
	const successCount = results.filter((r) => r.success).length;
	const summaries = results
		.map(
			(result) =>
				`### [${result.agent}] ${result.success ? "completed" : "failed"}\n\n${result.text}`,
		)
		.join("\n\n---\n\n");

	return `Parallel: ${successCount}/${results.length} tasks\n\n${summaries}`;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface RunResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

type OnUpdate = (update: {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}) => void;

/**
 * Run sub-agent delegations according to the tool parameters.
 *
 * The only public parameters are:
 *   tasks?: [{agent, task, cwd?}]
 *   timeout?: number
 *
 * - Missing or empty tasks lists available agents.
 * - One task runs a single visible sub-agent.
 * - Multiple tasks run visible sub-agents in parallel (with concurrency cap).
 * - Legacy API keys (agent, chain, cwd, agentScope, confirmProjectAgents) return guidance.
 *
 * Backend detection is deferred until tasks actually need to spawn.
 */
export async function runSubagents(
	delegationPrefix: string | undefined,
	options: RunnerOptions,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdate | undefined,
): Promise<RunResult> {
	// ------------------------------------------------------------------
	// Legacy shape detection: if old API keys are present, give guidance.
	// ------------------------------------------------------------------
	const legacyKey = detectLegacyParams(params);
	if (legacyKey) {
		return {
			content: [
				{
					type: "text",
					text:
						`The "${legacyKey}" parameter is no longer accepted. ` +
						`Use tasks: [{agent, task, cwd?}] instead. ` +
						"One task runs a single visible sub-agent; multiple tasks run in parallel.",
				},
			],
			details: {},
			isError: true,
		};
	}

	// ------------------------------------------------------------------
	// Parse tasks from params.
	// ------------------------------------------------------------------
	const tasksParam = params.tasks;
	const tasks = Array.isArray(tasksParam)
		? (tasksParam as Array<Record<string, unknown>>)
		: null;

	// ------------------------------------------------------------------
	// No tasks — list available agents. No backend needed.
	// ------------------------------------------------------------------
	if (!tasks || tasks.length === 0) {
		return listAgents(options);
	}

	// ------------------------------------------------------------------
	// Cap check.
	// ------------------------------------------------------------------
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return {
			content: [
				{
					type: "text",
					text: `Too many tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				},
			],
			details: {},
			isError: true,
		};
	}

	// ------------------------------------------------------------------
	// Validate each task before agent resolution.
	// ------------------------------------------------------------------
	for (const taskParam of tasks) {
		const agent = typeof taskParam.agent === "string" ? taskParam.agent.trim() : "";
		const task = typeof taskParam.task === "string" ? taskParam.task.trim() : "";
		if (!agent || !task) {
			return {
				content: [
					{
						type: "text",
						text: "Each task requires 'agent' and 'task' string fields.",
					},
				],
				details: {},
				isError: true,
			};
		}
	}

	// ------------------------------------------------------------------
	// Resolve all agents upfront against the parent session directory.
	// Per-task cwd affects only the child execution location, not discovery.
	// ------------------------------------------------------------------
	const scope = internalScope(options.includeProjectAgents);
	const taskInfos: ResolvedTask[] = [];
	const idPrefix = delegationPrefix ?? "anon";
	for (let i = 0; i < tasks.length; i++) {
		const taskParam = tasks[i];
		const agent = (taskParam.agent as string).trim();
		const task = (taskParam.task as string).trim();
		const taskCwd = typeof taskParam.cwd === "string" ? taskParam.cwd : options.parentCwd;
		const resolved = resolveAgent(agent, scope, options.parentCwd);
		if ("error" in resolved) {
			return {
				content: [{ type: "text", text: resolved.error }],
				details: {},
				isError: true,
			};
		}
		taskInfos.push({
			invocationId: `${idPrefix}:${i}`,
			index: i,
			agent,
			task,
			cwd: taskCwd,
			config: resolved,
		});
	}

	// ------------------------------------------------------------------
	// Detect backend (only now that we know we need to spawn).
	// ------------------------------------------------------------------
	const backendSelection = options.detectAutoBackend();
	if (!backendSelection.ok) {
		return {
			content: [{ type: "text", text: backendSelection.message }],
			details: { ...backendSelection.details },
			isError: true,
		};
	}
	const backend = backendSelection.backend;

	// ------------------------------------------------------------------
	// Derive per-task timeout.
	// ------------------------------------------------------------------
	const timeoutMinutes =
		typeof params.timeout === "number" &&
		Number.isInteger(params.timeout) &&
		params.timeout > 0
			? params.timeout
			: DEFAULT_TIMEOUT_MINUTES;

	// ------------------------------------------------------------------
	// Delegate to single or parallel execution.
	// ------------------------------------------------------------------
	if (taskInfos.length === 1) {
		return runSingle(taskInfos[0], backend, timeoutMinutes, signal, onUpdate);
	}
	return runParallel(taskInfos, backend, timeoutMinutes, signal, onUpdate);
}

// ---------------------------------------------------------------------------
// List available agents
// ---------------------------------------------------------------------------

async function listAgents(options: RunnerOptions): Promise<RunResult> {
	const scope = internalScope(options.includeProjectAgents);

	const userAgents = scope !== "project" ? discoverUserAgents() : [];
	const projectAgents =
		scope === "project" || scope === "both"
			? discoverProjectAgents(options.parentCwd)
			: [];

	const trustNote =
		!options.includeProjectAgents
			? "\n\nProject-local agents are hidden because the parent project is not trusted. Use /trust to trust this project."
			: "";

	return {
		content: [
			{
				type: "text",
				text: `Available agents:\n\n${formatMergedAgentList(mergeAgentLists(userAgents, projectAgents))}${trustNote}`,
			},
		],
		details: {},
	};
}

// ---------------------------------------------------------------------------
// Single-agent execution
// ---------------------------------------------------------------------------

async function runSingle(
	taskInfo: ResolvedTask,
	backend: SubagentBackend,
	timeoutMinutes: number,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdate | undefined,
): Promise<RunResult> {
	const { invocationId } = taskInfo;

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `launching — spawning "${taskInfo.agent}"…`,
			},
		],
		details: {},
	});

	let spawned: SpawnedSubagent;
	let outcome: SubagentOutcome;
	let cleanupError: string | null = null;

	try {
		const spawnedBatch = await backend.spawnBatch(
			[
				{
					invocationId,
					agentName: taskInfo.agent,
					task: taskInfo.task,
					cwd: taskInfo.cwd,
					config: taskInfo.config,
				},
			],
			{ signal },
		);

		const validation = validateBatchResult([invocationId], spawnedBatch);
		if (!validation.ok) {
			const cleanupErrors = cleanupSpawnedAttempts(spawnedBatch);
			return {
				content: [{ type: "text", text: "Backend returned an invalid spawn result." }],
				details: {
					mode: "single",
					invocationId,
					contractError: validation.details,
					cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
				},
				isError: true,
			};
		}

		const attempt = validation.attemptsById.get(invocationId);
		if (!attempt) {
			return {
				content: [{ type: "text", text: "Backend returned an invalid spawn result." }],
				details: { mode: "single", invocationId, contractError: { reason: "missing_invocation" } },
				isError: true,
			};
		}

		if (attempt.status !== "spawned") {
			const result = attemptFailureResult(taskInfo, attempt);
			return {
				content: [{ type: "text", text: result.text }],
				details: { mode: "single", invocationId, ...result.details },
				isError: true,
			};
		}

		spawned = attempt.spawned;

		try {
			outcome = await backend.waitForCompletion(spawned, {
				timeoutMs: timeoutMinutes * 60 * 1000,
				signal,
				onProgress: (statusLine) => {
					onUpdate?.({
						content: [{ type: "text", text: statusLine }],
						details: {},
					});
				},
			});
		} finally {
			cleanupError = cleanupSpawned(spawned);
		}
	} catch (err: unknown) {
		const error = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: "agent delegation failed." }],
			details: {
				mode: "single",
				invocationId,
				delegationError: error,
				cleanupError: cleanupError ?? undefined,
			},
			isError: true,
		};
	}

	const { text, details: resultDetails } = formatSingleResult(
		taskInfo.agent,
		outcome,
		spawned,
		timeoutMinutes,
	);

	return {
		content: [{ type: "text", text }],
		details: {
			...resultDetails,
			invocationId,
			agentSource: taskInfo.config.source,
			agentModel: taskInfo.config.model ?? undefined,
			cleanupError: cleanupError ?? undefined,
		},
	};
}

// ---------------------------------------------------------------------------
// Parallel execution
// ---------------------------------------------------------------------------

async function runParallel(
	taskInfos: ResolvedTask[],
	backend: SubagentBackend,
	timeoutMinutes: number,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdate | undefined,
): Promise<RunResult> {
	const results: Array<ParallelResult | undefined> = new Array(taskInfos.length);
	const tasksByInvocationId = new Map(taskInfos.map((task) => [task.invocationId, task]));
	let settledCount = 0;

	const recordResult = (task: ResolvedTask, result: ParallelResult) => {
		if (results[task.index]) return;
		results[task.index] = result;
		settledCount++;
		onUpdate?.({
			content: [{ type: "text", text: `parallel — ${settledCount}/${taskInfos.length} tasks settled…` }],
			details: {},
		});
	};

	const markRemainingNotStarted = (
		fromIndex: number,
		reason: "aborted" | "catastrophic",
		error: string,
	) => {
		for (const task of taskInfos.slice(fromIndex)) {
			recordResult(task, notStartedResult(task, reason, error));
		}
	};

	for (let batchStart = 0; batchStart < taskInfos.length; batchStart += MAX_CONCURRENCY) {
		if (signal?.aborted) {
			markRemainingNotStarted(batchStart, "aborted", "delegation was aborted before this task launched");
			break;
		}

		const batchTasks = taskInfos.slice(batchStart, batchStart + MAX_CONCURRENCY);
		const batchEnd = batchStart + batchTasks.length;
		const batchRequestedIds = batchTasks.map((task) => task.invocationId);

		onUpdate?.({
			content: [
				{
					type: "text",
					text: `parallel — spawning tasks ${batchStart + 1}-${batchEnd} of ${taskInfos.length}…`,
				},
			],
			details: {},
		});

		let batchResult: SpawnBatchResult;
		try {
			batchResult = await backend.spawnBatch(
				batchTasks.map((task) => ({
					invocationId: task.invocationId,
					agentName: task.agent,
					task: task.task,
					cwd: task.cwd,
					config: task.config,
				})),
				{ signal },
			);
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			markRemainingNotStarted(batchStart, "catastrophic", error);
			break;
		}

		const validation = validateBatchResult(batchRequestedIds, batchResult);
		if (!validation.ok) {
			const cleanupErrors = cleanupSpawnedAttempts(batchResult);
			for (const task of batchTasks) {
				recordResult(task, {
					invocationId: task.invocationId,
					agent: task.agent,
					targetId: "",
					text: "Backend returned an invalid spawn result.",
					success: false,
					details: {
						spawnStatus: "contract_error",
						contractError: validation.details,
						cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
					},
				});
			}
			markRemainingNotStarted(batchEnd, "catastrophic", "backend returned an invalid spawn result");
			break;
		}

		const spawnedAttempts: Array<Extract<SpawnAttempt, { status: "spawned" }>> = [];
		for (const task of batchTasks) {
			const attempt = validation.attemptsById.get(task.invocationId);
			if (!attempt) {
				recordResult(task, notStartedResult(task, "catastrophic", "backend omitted this task result"));
				continue;
			}
			if (attempt.status === "spawned") spawnedAttempts.push(attempt);
			else recordResult(task, attemptFailureResult(task, attempt));
		}

		if (spawnedAttempts.length > 0) {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `parallel — waiting for tasks ${batchStart + 1}-${batchEnd} of ${taskInfos.length}…`,
					},
				],
				details: {},
			});
		}

		await Promise.all(spawnedAttempts.map(async (attempt) => {
			const task = tasksByInvocationId.get(attempt.invocationId);
			if (!task) return;
			const spawned = attempt.spawned;

			try {
				const outcome = await backend.waitForCompletion(spawned, {
					timeoutMs: timeoutMinutes * 60 * 1000,
					signal,
					onProgress: (statusLine) => {
						onUpdate?.({
							content: [{ type: "text", text: `[${task.agent}] ${statusLine}` }],
							details: {},
						});
					},
				});
				const formattedOutcome = formatOutcome(outcome, spawned.displayTarget, timeoutMinutes);
				recordResult(task, {
					invocationId: task.invocationId,
					agent: task.agent,
					targetId: spawned.id,
					text: formattedOutcome.text,
					success: formattedOutcome.success,
					details: { ...formattedOutcome.details },
				});
			} catch (err: unknown) {
				recordResult(task, {
					invocationId: task.invocationId,
					agent: task.agent,
					targetId: spawned.id,
					text: `wait failed: ${err instanceof Error ? err.message : String(err)}`,
					success: false,
					details: { waitError: err instanceof Error ? err.message : String(err) },
				});
			} finally {
				const cleanupError = cleanupSpawned(spawned);
				const taskResult = results[task.index];
				if (cleanupError && taskResult) taskResult.details.cleanupError = cleanupError;
			}
		}));
	}

	const finalResults = taskInfos.map(
		(task) =>
			results[task.index] ??
			notStartedResult(task, "catastrophic", "runner did not produce a terminal task result"),
	);
	const summaryText = formatParallelResults(finalResults);
	const summaryDetails = finalResults.map((result) => ({
		invocationId: result.invocationId,
		agent: result.agent,
		targetId: result.targetId,
		success: result.success,
		...result.details,
	}));

	return {
		content: [{ type: "text", text: summaryText }],
		details: { mode: "parallel", results: summaryDetails },
		isError: !finalResults.some((result) => result.success),
	};
}
