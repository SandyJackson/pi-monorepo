import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectSession, type SessionAnswerRef } from "../pi-session.ts";
import { HerdrRpcResponseError, type HerdrRpcCall } from "./rpc.ts";

// ---------------------------------------------------------------------------
// Types — refs only, no answer text
// ---------------------------------------------------------------------------

export interface VisibleSubagentSessionRef {
	paneId: string;
	label: string;
	pi?: { id: string; path: string; cwd: string };
}

export type DelegatedTaskOutcome =
	| { status: "completed"; session: VisibleSubagentSessionRef; answer: SessionAnswerRef | null }
	| { status: "timed_out"; session: VisibleSubagentSessionRef }
	| { status: "aborted"; stage: "before_launch" }
	| { status: "aborted"; stage: "observing"; session: VisibleSubagentSessionRef }
	| { status: "session_closed"; session: VisibleSubagentSessionRef }
	| { status: "launch_failed"; error: string }
	| { status: "launch_indeterminate"; error: string; possiblePaneId: string }
	| { status: "observation_failed"; session: VisibleSubagentSessionRef; error: string };

export interface AgentConfigForSession {
	name: string;
	model?: string;
	tools?: string[];
	systemPromptBody: string;
}

export interface DelegatedTask {
	agent: string;
	instruction: string;
	cwd: string;
	config: AgentConfigForSession;
}

/** Options for observing one delegated turn of a confirmed visible session. */
export interface ObserveTurnOptions {
	/** Per-task timeout starting at confirmed launch. */
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (line: string) => void;
}

/**
 * Result of one delegated-task launch attempt.
 *
 * Either the launch is confirmed — the caller receives a persistent session
 * handle whose `observeTurn` watches the initial turn — or the launch ended
 * in a terminal outcome that needs no observation.
 */
export type DelegatedTaskLaunch =
	| {
		status: "launched";
		session: VisibleSubagentSessionRef;
		observeTurn(options?: ObserveTurnOptions): Promise<DelegatedTaskOutcome>;
	}
	| Extract<DelegatedTaskOutcome, { status: "launch_failed" | "launch_indeterminate" }>
	| Extract<DelegatedTaskOutcome, { status: "aborted"; stage: "before_launch" }>;

export interface LaunchDelegatedTaskOptions {
	rpc: HerdrRpcCall;
	/** Pane the child should start in. */
	targetPaneId: string;
	task: DelegatedTask;
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 800;
const STABLE_SETTLED_POLLS = 2;
const PANE_LABEL_MAX_LENGTH = 32;
const MAX_NAME_ALLOCATION_ATTEMPTS = 100;
const PANE_READINESS_RETRY_ATTEMPTS = 10;
const PANE_READINESS_RETRY_DELAY_MS = 250;
const PROMPT_CLEANUP_FALLBACK_MS = 60_000;
export const DEFAULT_RPC_TIMEOUT = 5000;
const START_RPC_TIMEOUT = 15_000;

/** Default per-task timeout, measured from confirmed launch. */
export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sanitizeArgForHerdr(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ");
}

function buildPaneLabel(agent: string, instruction: string, ordinal = 1): string {
	const prefix = "sa-";
	const suffix = ordinal > 1 ? `-${ordinal}` : "";
	const readableSlug = `${agent}-${instruction}`
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const available = PANE_LABEL_MAX_LENGTH - prefix.length - suffix.length;
	const readable =
		((readableSlug || "agent").slice(0, Math.max(1, available)).replace(/-+$/, "") || "agent");
	return `${prefix}${readable}${suffix}`.slice(0, PANE_LABEL_MAX_LENGTH);
}

/**
 * Abortable sleep. Implemented directly on the global timer (not
 * `node:timers/promises`, which binds the un-fakeable module timer) so tests
 * can control it with fake timers. Abort resolves rather than rejects so
 * polling loops can re-check cancellation at their top.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
		timer.unref?.();
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", finish, { once: true });
	});
}

// ---------------------------------------------------------------------------
// Herdr types
// ---------------------------------------------------------------------------


interface HerdrAgentListResult { agents?: Array<{ agent?: string }>; }
interface HerdrStartResult { agent?: { pane_id?: string }; pane_id?: string; }
interface HerdrAgentInfo {
	agent?: { agent_status?: string; agent_session?: { value?: string; path?: string } };
	agent_status?: string;
	agent_session?: { value?: string; path?: string };
}

class ConfirmedLaunchFailure extends Error { }
class IndeterminateLaunchFailure extends Error { }


// ---------------------------------------------------------------------------
// Prompt lease — private, idempotent, never closes pane
// ---------------------------------------------------------------------------

interface PromptLease {
	args: string[];
	confirmConsumed(): void;
	releaseNow(): void;
	releaseWhenConsumedOrExpired(): void;
}

function createPromptLease(body: string): PromptLease {
	if (!body) {
		return {
			args: [] as string[],
			confirmConsumed: () => { },
			releaseNow: () => { },
			releaseWhenConsumedOrExpired: () => { },
		};
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const file = path.join(dir, "system-prompt.md");
	let cleaned = false;
	let consumed = false;
	let requested = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const doCleanup = () => {
		if (cleaned) return;
		cleaned = true;
		clearTimeout(timer);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
	};

	try {
		fs.writeFileSync(file, body, "utf-8");
	} catch (err) {
		doCleanup();
		throw err;
	}

	return {
		args: ["--append-system-prompt", file] as string[],
		confirmConsumed: () => {
			consumed = true;
			if (requested) doCleanup();
		},
		releaseNow: doCleanup,
		releaseWhenConsumedOrExpired: () => {
			requested = true;
			if (consumed) doCleanup();
			else if (!timer) {
				timer = setTimeout(doCleanup, PROMPT_CLEANUP_FALLBACK_MS);
				timer.unref?.();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Agent launch — argv, naming, pane readiness
// ---------------------------------------------------------------------------

function buildAgentArguments(
	task: DelegatedTask,
	promptArgs: string[],
): string[] {
	const argv: string[] = [];
	if (task.config.model) argv.push("--model", task.config.model);
	if (task.config.tools !== undefined && task.config.tools.length > 0) {
		argv.push("--tools", task.config.tools.join(","));
	}
	argv.push(...promptArgs);
	argv.push(sanitizeArgForHerdr(task.instruction));
	return argv;
}

function isPaneBusyError(error: unknown): boolean {
	return (
		error instanceof HerdrRpcResponseError &&
		(error.code === "agent_pane_busy" || error.code === "agent_pane_unavailable")
	);
}

async function startWhenPaneReady(
	rpc: HerdrRpcCall,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		if (signal?.aborted) throw new Error("aborted before launch");
		try {
			return await rpc("agent.start", params, START_RPC_TIMEOUT, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			if (attempt >= PANE_READINESS_RETRY_ATTEMPTS || !isPaneBusyError(error)) throw error;
			await sleep(PANE_READINESS_RETRY_DELAY_MS, signal);
			if (signal?.aborted) throw new Error("aborted before launch");
		}
	}
}

async function allocateAndStartAgent(
	rpc: HerdrRpcCall,
	targetPaneId: string,
	task: DelegatedTask,
	promptArgs: string[],
	signal?: AbortSignal,
): Promise<{ paneId: string; label: string }> {
	const listed = (await rpc("agent.list", {}, DEFAULT_RPC_TIMEOUT, signal)) as HerdrAgentListResult;
	if (!Array.isArray(listed.agents)) throw new Error(`agent.list returned no agents array:\n${JSON.stringify(listed).slice(0, 300)}`);
	const occupied = new Set(listed.agents.map((e) => e.agent?.trim()).filter((n): n is string => Boolean(n)));

	const argv = buildAgentArguments(task, promptArgs);

	for (let ordinal = 1, attempts = 0; attempts < MAX_NAME_ALLOCATION_ATTEMPTS; attempts++, ordinal++) {
		const label = buildPaneLabel(task.agent, task.instruction, ordinal);
		if (occupied.has(label)) continue;

		const params: Record<string, unknown> = {
			name: label,
			kind: "pi",
			pane_id: targetPaneId,
			args: ["--name", label, ...argv],
		};

		let raw: unknown;
		let hasAttemptedStart = false;
		try {
			if (signal?.aborted) throw new Error("aborted before launch");
			hasAttemptedStart = true;
			raw = await startWhenPaneReady(rpc, params, signal);
		} catch (err) {
			if (err instanceof Error && err.message === "aborted before launch") throw err;
			// Explicit server responses are confirmed regardless of concurrent
			// cancellation; only transport ambiguity after agent.start may have run
			// is indeterminate.
			if (err instanceof HerdrRpcResponseError) {
				if (err.code === "agent_name_taken") {
					occupied.add(label);
					continue;
				}
				throw new ConfirmedLaunchFailure(err.message);
			}
			if (signal?.aborted && !hasAttemptedStart) throw err;
			throw new IndeterminateLaunchFailure(err instanceof Error ? err.message : String(err));
		}

		const startResult = raw as HerdrStartResult | null;
		const paneId = startResult?.agent?.pane_id ?? startResult?.pane_id ?? null;
		if (!paneId) throw new IndeterminateLaunchFailure(`agent.start returned no pane_id:\n${JSON.stringify(startResult).slice(0, 300)}`);
		return { paneId, label };
	}

	throw new ConfirmedLaunchFailure(
		`could not allocate a unique Herdr agent name after ${MAX_NAME_ALLOCATION_ATTEMPTS} attempts`,
	);
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function isSessionClosedError(error: unknown): boolean {
	if (error instanceof HerdrRpcResponseError) {
		return error.code === "not_found" || error.code === "pane_not_found" || error.code === "no_such_pane";
	}
	return false;
}

function readAgentObservation(info: unknown): { status: string; sessionPath: string | null } | { invalid: string } {
	if (typeof info !== "object" || info === null) return { invalid: "invalid agent.get response" };
	const rpcResponse = info as Record<string, unknown>;
	const agentPayload = rpcResponse.agent;
	if (agentPayload !== undefined && (typeof agentPayload !== "object" || agentPayload === null || Array.isArray(agentPayload))) {
		return { invalid: "invalid agent.get response" };
	}
	const payload = (agentPayload ?? rpcResponse) as Record<string, unknown>;
	const statusRaw = payload.agent_status ?? (rpcResponse as Record<string, unknown>).agent_status;
	if (typeof statusRaw !== "string") return { invalid: "invalid agent.get response" };
	const status: string = statusRaw;
	const sessionRaw =
		(payload.agent_session as { value?: unknown; path?: unknown } | undefined)?.value ??
		(payload.agent_session as { value?: unknown; path?: unknown } | undefined)?.path ??
		(rpcResponse as { agent_session?: { value?: unknown; path?: unknown } }).agent_session?.value ??
		(rpcResponse as { agent_session?: { value?: unknown; path?: unknown } }).agent_session?.path ??
		null;
	const sessionPath = typeof sessionRaw === "string" && sessionRaw.length > 0 ? sessionRaw : null;
	return { status, sessionPath };
}

interface ObserveTurnUntilSettledOptions {
	rpc: HerdrRpcCall;
	session: VisibleSubagentSessionRef;
	/** Absolute turn deadline, computed by the caller from confirmed-launch time. */
	deadline: number;
	signal?: AbortSignal;
	onProgress?: (line: string) => void;
	promptLease: PromptLease;
}

/** Wait one poll interval, capped to the remaining turn deadline. */
function pollDelay(deadline: number, signal?: AbortSignal): Promise<void> {
	return sleep(Math.max(0, Math.min(POLL_INTERVAL_MS, deadline - Date.now())), signal);
}

async function observeTurnUntilSettled(options: ObserveTurnUntilSettledOptions): Promise<DelegatedTaskOutcome> {
	const { rpc, session, deadline, signal, onProgress, promptLease } = options;
	const paneId = session.paneId;

	let hasObservedActivity = false;
	let consecutiveSettledPolls = 0;
	let observedSession = session;
	let answer: SessionAnswerRef | null = null;

	try {
		for (;;) {
			if (signal?.aborted) return { status: "aborted", stage: "observing", session: observedSession };

			let status: string | null = null;
			let sessionPath: string | null = null;

			try {
				const info = (await rpc("agent.get", { target: paneId }, DEFAULT_RPC_TIMEOUT, signal)) as unknown;
				const observed = readAgentObservation(info);
				if ("invalid" in observed) return { status: "observation_failed", session: observedSession, error: observed.invalid };
				status = observed.status;
				sessionPath = observed.sessionPath;
			} catch (err) {
				if (isSessionClosedError(err)) return { status: "session_closed", session: observedSession };
				if (err instanceof HerdrRpcResponseError) return { status: "observation_failed", session: observedSession, error: err.message };
				const errorMessage = String(err instanceof Error ? err.message : err);
				if (errorMessage.includes("aborted") && signal?.aborted) return { status: "aborted", stage: "observing", session: observedSession };
				if (Date.now() >= deadline) {
					// fall through to timeout check below
				} else {
					onProgress?.(`watching:unknown — pane ${paneId}`);
					if (Date.now() >= deadline) return { status: "timed_out", session: observedSession };
					await pollDelay(deadline, signal);
					continue;
				}
			}

			if (sessionPath) {
				promptLease.confirmConsumed();
				try {
					const sessionSnapshot = inspectSession(sessionPath);
					if (sessionSnapshot.pi) observedSession = { paneId, label: session.label, pi: { id: sessionSnapshot.pi.id, path: sessionSnapshot.pi.path, cwd: sessionSnapshot.pi.cwd } };
					if (sessionSnapshot.answer) answer = sessionSnapshot.answer;
				} catch {}
			}

			if (status === "working" || status === "blocked") {
				hasObservedActivity = true;
				consecutiveSettledPolls = 0;
			} else if (hasObservedActivity && status !== null && (status === "idle" || status === "done")) {
				consecutiveSettledPolls += 1;
			} else {
				consecutiveSettledPolls = 0;
			}

			onProgress?.(`watching:${status ?? "unknown"} — pane ${paneId}${answer ? " (final answer captured)" : ""}`);

			if (hasObservedActivity && consecutiveSettledPolls >= STABLE_SETTLED_POLLS) {
				return { status: "completed", session: observedSession, answer };
			}
			if (Date.now() >= deadline) return { status: "timed_out", session: observedSession };

			await pollDelay(deadline, signal);
		}
	} finally {
		// The observation ended — possibly without ever observing a session
		// path. Consumed prompts are already released; the rest expire via the
		// conservative fallback timer.
		promptLease.releaseWhenConsumedOrExpired();
	}
}

// ---------------------------------------------------------------------------
// Public deep operation
// ---------------------------------------------------------------------------

/**
 * Launch one delegated task into a visible subagent session.
 *
 * Never throws for expected operational conditions: confirmed failures,
 * ambiguous starts, and pre-launch cancellation are returned as outcomes.
 * The timeout deadline begins when the launch is confirmed, so `observeTurn`
 * must be called promptly after a successful launch.
 */
export async function launchDelegatedTask(options: LaunchDelegatedTaskOptions): Promise<DelegatedTaskLaunch> {
	const { rpc, targetPaneId, task, signal } = options;

	let promptLease: ReturnType<typeof createPromptLease>;
	try {
		promptLease = createPromptLease(task.config.systemPromptBody);
	} catch (err) {
		return { status: "launch_failed", error: err instanceof Error ? err.message : String(err) };
	}

	if (signal?.aborted) {
		promptLease.releaseNow();
		return { status: "aborted", stage: "before_launch" };
	}

	let paneId: string;
	let label: string;
	try {
		const launched = await allocateAndStartAgent(rpc, targetPaneId, task, promptLease.args, signal);
		paneId = launched.paneId;
		label = launched.label;
	} catch (err) {
		if (err instanceof IndeterminateLaunchFailure) {
			promptLease.releaseWhenConsumedOrExpired();
			return { status: "launch_indeterminate", error: err.message, possiblePaneId: targetPaneId };
		}
		promptLease.releaseNow();
		if (err instanceof ConfirmedLaunchFailure) {
			return { status: "launch_failed", error: err.message };
		}
		if (signal?.aborted) {
			return { status: "aborted", stage: "before_launch" };
		}
		return { status: "launch_failed", error: err instanceof Error ? err.message : String(err) };
	}

	// Confirmed launch — the turn deadline starts now. The prompt lease is
	// released only when the turn's observation ends (or the child consumes it).
	const startedAt = Date.now();
	const session: VisibleSubagentSessionRef = { paneId, label };

	return {
		status: "launched",
		session,
		observeTurn: (observeOptions: ObserveTurnOptions = {}) =>
			observeTurnUntilSettled({
				rpc,
				session,
				deadline: startedAt + (observeOptions.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS),
				signal: observeOptions.signal,
				onProgress: observeOptions.onProgress,
				promptLease,
			}),
	};
}
