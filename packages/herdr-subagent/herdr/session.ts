import * as fs from "node:fs";
// #FIXME: launch/prompt/observation duplicates herdr-backend; to be consolidated in delegation extraction (see subagents_refactor_structure.md)
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
	agentName: string;
	task: string;
	cwd: string;
	config: AgentConfigForSession;
}

export interface DelegatedTaskRunOptions {
	rpc: HerdrRpcCall;
	targetPaneId: string;
	task: DelegatedTask;
	signal?: AbortSignal;
	timeoutMs?: number;
	onProgress?: (line: string) => void;
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
const DEFAULT_RPC_TIMEOUT = 5000;
const START_RPC_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sanitizeArgForHerdr(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ");
}

function buildPaneLabel(agentName: string, task: string, ordinal = 1): string {
	const prefix = "sa-";
	const suffix = ordinal > 1 ? `-${ordinal}` : "";
	const readableSlug = `${agentName}-${task}`
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const available = PANE_LABEL_MAX_LENGTH - prefix.length - suffix.length;
	const readable =
		((readableSlug || "agent").slice(0, Math.max(1, available)).replace(/-+$/, "") || "agent");
	return `${prefix}${readable}${suffix}`.slice(0, PANE_LABEL_MAX_LENGTH);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

class ConfirmedLaunchFailure extends Error {}
class IndeterminateLaunchFailure extends Error {}


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
			confirmConsumed: () => {},
			releaseNow: () => {},
			releaseWhenConsumedOrExpired: () => {},
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
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
	argv.push(sanitizeArgForHerdr(task.task));
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
		const label = buildPaneLabel(task.agentName, task.task, ordinal);
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
			if (signal?.aborted && !hasAttemptedStart) throw err;
			if (signal?.aborted && hasAttemptedStart) {
				if (isPaneBusyError(err)) {
				throw err;
			}
				throw new IndeterminateLaunchFailure(err instanceof Error ? err.message : String(err));
			}
			if (err instanceof HerdrRpcResponseError && err.code === "agent_name_taken") {
				occupied.add(label);
				continue;
			}
			if (err instanceof HerdrRpcResponseError) throw new ConfirmedLaunchFailure(err.message);
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

// ---------------------------------------------------------------------------
// Public deep operation
// ---------------------------------------------------------------------------

export async function executeDelegatedTask(options: DelegatedTaskRunOptions): Promise<DelegatedTaskOutcome> {
	const { rpc, targetPaneId, task, signal, timeoutMs, onProgress } = options;

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
		if (err instanceof ConfirmedLaunchFailure) {
			promptLease.releaseNow();
			return { status: "launch_failed", error: err.message };
		}
		if (signal?.aborted) {
			promptLease.releaseNow();
			return { status: "aborted", stage: "before_launch" };
		}
		promptLease.releaseNow();
		return { status: "launch_failed", error: err instanceof Error ? err.message : String(err) };
	}

	// Confirmed launch — deadline starts now, retain prompt until consumed or fallback
	const timeout = timeoutMs ?? 20 * 60 * 1000;
	const deadline = Date.now() + timeout;
	promptLease.releaseWhenConsumedOrExpired();

	let hasObservedActivity = false;
	let consecutiveSettledPolls = 0;
	let session: VisibleSubagentSessionRef = { paneId, label };
	let answer: SessionAnswerRef | null = null;

	for (;;) {
		if (signal?.aborted) return { status: "aborted", stage: "observing", session };

		let status: string | null = null;
		let sessionPath: string | null = null;

		try {
			const info = (await rpc("agent.get", { target: paneId }, DEFAULT_RPC_TIMEOUT, signal)) as unknown;
			const observed = readAgentObservation(info);
			if ("invalid" in observed) return { status: "observation_failed", session, error: observed.invalid };
			status = observed.status;
			sessionPath = observed.sessionPath;
		} catch (err) {
			if (isSessionClosedError(err)) return { status: "session_closed", session };
			if (err instanceof HerdrRpcResponseError) return { status: "observation_failed", session, error: err.message };
			const errorMessage = String(err instanceof Error ? err.message : err);
			if (errorMessage.includes("aborted") && signal?.aborted) return { status: "aborted", stage: "observing", session };
			if (Date.now() >= deadline) {
				// fall through to timeout check below
			} else {
				onProgress?.(`watching:unknown — pane ${paneId}`);
				if (Date.now() >= deadline) return { status: "timed_out", session };
				await sleep(POLL_INTERVAL_MS, signal);
				continue;
			}
		}

		if (sessionPath) {
			promptLease.confirmConsumed();
			try {
				const sessionSnapshot = inspectSession(sessionPath);
				if (sessionSnapshot.pi) session = { paneId, label, pi: { id: sessionSnapshot.pi.id, path: sessionSnapshot.pi.path, cwd: sessionSnapshot.pi.cwd } };
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
			return { status: "completed", session, answer };
		}
		if (Date.now() >= deadline) return { status: "timed_out", session };

		await sleep(POLL_INTERVAL_MS, signal);
	}
}
