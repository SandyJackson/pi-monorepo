import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Pi session identity parsed from the JSONL header. */
export interface PiSessionInfo {
	id: string;
	path: string;
	cwd: string;
}

/** Exact reference to a persisted terminal assistant entry. */
export interface SessionAnswerRef {
	path: string;
	entryId: string;
}

/** Snapshot returned by inspection of a Pi session file. */
export interface PiSessionSnapshot {
	pi: PiSessionInfo | null;
	answer: SessionAnswerRef | null;
}

/** Legacy extracted answer shape. */
export interface SessionAnswer {
	text: string;
}

/** Minimal shape of a session header entry. */
interface SessionHeaderEntry {
	type?: string;
	id?: unknown;
	cwd?: unknown;
}

/** Minimal shape of a persisted entry with message. */
interface PersistedMessageEntry {
	id?: unknown;
	type?: string;
	message?: {
		role?: unknown;
		stopReason?: unknown;
		content?: unknown;
	};
}

function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractMessageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			text += part.text;
		}
	}
	return text;
}

function tryParseRecord(line: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(line) as unknown;
		if (!isRecord(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function isAnswerBearingEntry(entry: unknown): entry is PersistedMessageEntry & {
	id: string;
	type: "message";
	message: { role: "assistant"; stopReason: "stop" | "end_turn"; content?: unknown };
} {
	if (!isRecord(entry)) return false;
	const candidate = entry as PersistedMessageEntry;
	if (!isNonBlankString(candidate.id)) return false;
	if (candidate.type !== "message") return false;
	const candidateMessage = candidate.message;
	if (!isRecord(candidateMessage)) return false;
	if (candidateMessage.role !== "assistant") return false;
	const stopReason = typeof candidateMessage.stopReason === "string" ? candidateMessage.stopReason : "";
	if (stopReason !== "stop" && stopReason !== "end_turn") return false;
	return true;
}

/**
 * Simple streamed JSONL reader matching Pi's behavior:
 * read fixed-size chunks, preserve partial UTF-8 with StringDecoder,
 * accumulate until newline, parse each complete physical line,
 * process final unterminated line at EOF. Memory proportional to the
 * longest physical line (necessary for JSON.parse).
 */
function forEachNonBlankLineSync(
	filePath: string,
	onLine: (line: string) => boolean | void,
): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return;
	}

	const decoder = new StringDecoder("utf8");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let pending = "";

	try {
		while (true) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) {
				pending += decoder.end();
				if (pending.trim() && onLine(pending) === true) return;
				break;
			}
			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const line = pending.slice(lineStart, newlineIndex);
				if (line.trim() && onLine(line) === true) return;
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore close errors */
			}
		}
	}
}

/**
 * Read the Pi session header — the first non-blank JSONL line.
 * Keeps Pi's official 1 MiB bound for header discovery.
 */
function readHeader(sessionPath: string): PiSessionInfo | null {
	let headerResult: PiSessionInfo | null = null;
	let decided = false;

	forEachNonBlankLineSync(sessionPath, (line) => {
		// Header bound: Pi caps header scan at 1 MiB
		if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
			headerResult = null;
			decided = true;
			return true;
		}
		const record = tryParseRecord(line);
		if (!record) {
			headerResult = null;
			decided = true;
			return true;
		}
		const header = record as SessionHeaderEntry;
		if (header.type === "session" && isNonBlankString(header.id) && isNonBlankString(header.cwd)) {
			headerResult = { id: header.id.trim(), path: sessionPath, cwd: header.cwd.trim() };
		} else {
			headerResult = null;
		}
		decided = true;
		return true;
	});

	if (!decided) return null;
	return headerResult;
}

/**
 * Find the latest substantive terminal assistant entry, falling back to the
 * first whitespace-only entry.
 */
function findAnswer(sessionPath: string): SessionAnswerRef | null {
	let bestEntryId: string | null = null;

	forEachNonBlankLineSync(sessionPath, (line) => {
		const record = tryParseRecord(line);
		if (!record) return;
		if (!isAnswerBearingEntry(record)) return;
		const text = extractMessageText(record.message);
		if (text.trim().length > 0) bestEntryId = record.id;
		else if (bestEntryId === null && text.length > 0) bestEntryId = record.id;
	});

	return bestEntryId ? { path: sessionPath, entryId: bestEntryId } : null;
}

/**
 * Inspect a Pi session JSONL file for durable identity and exact terminal
 * assistant entry reference.
 *
 * Two focused passes — `readHeader` for the first non-blank line and
 * `findAnswer` for the latest substantive answer — each streaming with
 * constant buffer, matching `pi-coding-agent`.
 */
export function inspectSession(sessionPath: string): PiSessionSnapshot {
	const pi = readHeader(sessionPath);
	const answer = findAnswer(sessionPath);
	return { pi, answer };
}

/**
 * Resolve an exact `{path, entryId}` answer reference to its persisted text.
 * Single streaming pass with early exit on `entryId` match.
 */
export function readAnswer(ref: SessionAnswerRef): string | null {
	let resolvedText: string | null | undefined;

	forEachNonBlankLineSync(ref.path, (line) => {
		const record = tryParseRecord(line);
		if (!record) return;
		if ((record as PersistedMessageEntry).id !== ref.entryId) return;
		if (!isAnswerBearingEntry(record)) {
			resolvedText = null;
			return true;
		}
		const text = extractMessageText((record as PersistedMessageEntry).message);
		if (text.length === 0) {
			resolvedText = null;
			return true;
		}
		resolvedText = text;
		return true;
	});

	return resolvedText ?? null;
}

/**
 * Legacy helper: read a Pi session file and extract the last substantive
 * assistant message text. Preserved for compatibility with the current
 * Herdr backend characterization tests; new code should use
 * `inspectSession` + `readAnswer` which requires a nonempty persisted
 * entry id and an exact `{path, entryId}` reference.
 *
 * Behavior preserves the substantive/whitespace selection from the original
 * implementation and intentionally does not require a persisted `id` so
 * existing scripted Herdr tests without ids continue to pass until the
 * Herdr backend migrates to the durable reference flow.
 */
export function readSessionAnswer(sessionPath: string): SessionAnswer | null {
	let finalAnswer: string | null = null;

	forEachNonBlankLineSync(sessionPath, (line) => {
		const record = tryParseRecord(line);
		if (!record) return;
		const entry = record as PersistedMessageEntry;

		if (entry.type !== "message") return;

		const candidateMessage = entry.message;
		if (!isRecord(candidateMessage)) return;
		if (candidateMessage.role !== "assistant") return;

		const stopReason: string = typeof candidateMessage.stopReason === "string" ? candidateMessage.stopReason : "";
		if (stopReason !== "stop" && stopReason !== "end_turn") return;

		const messageText = extractMessageText(candidateMessage as { content?: unknown });
		if (messageText.trim()) {
			finalAnswer = messageText;
		} else if (finalAnswer === null && messageText.length > 0) {
			finalAnswer = messageText;
		}
	});

	if (finalAnswer === null) return null;
	return { text: finalAnswer };
}
