import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Exact reference to a persisted terminal assistant entry. */
export interface SessionAnswerRef {
  path: string;
  entryId: string;
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
  const stopReason =
    typeof candidateMessage.stopReason === "string" ? candidateMessage.stopReason : "";
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
  onLine: (line: string) => boolean | undefined,
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

/** The answer selection rule, applied to entries in order: returns the new best entry ID. */
function considerAnswer(bestEntryId: string | null, entry: unknown): string | null {
  if (!isAnswerBearingEntry(entry)) return bestEntryId;
  const text = extractMessageText(entry.message);
  if (text.trim().length > 0) return entry.id;
  if (bestEntryId === null && text.length > 0) return entry.id;
  return bestEntryId;
}

function isUserEntryWithText(entry: unknown, text: string): boolean {
  if (!isRecord(entry) || entry.type !== "message") return false;
  const message = (entry as PersistedMessageEntry).message;
  return isRecord(message) && message.role === "user" && extractMessageText(message) === text;
}

/** Where a delegated request's answer is on the child's active branch. */
export type RequestAnswer =
  | { status: "found"; answer: SessionAnswerRef | null }
  | { status: "superseded" };

/**
 * Locate a request on the active branch (root first) and select its answer.
 *
 * The request entry is the first user message after `dispatchLeaf` (the
 * branch root when the session was empty) whose text equals `requestText`,
 * the text Pi started the request's run with.
 * The answer is the latest substantive terminal assistant entry after it,
 * or the first whitespace-only one when there is none. A missing dispatch point or request entry is `superseded`.
 */
export function findRequestAnswer(
  branch: readonly unknown[],
  options: { dispatchLeaf: string | null; requestText: string; sessionPath: string | undefined },
): RequestAnswer {
  let start = 0;
  if (options.dispatchLeaf !== null) {
    const leafIndex = branch.findIndex(
      (entry) => isRecord(entry) && entry.id === options.dispatchLeaf,
    );
    if (leafIndex === -1) return { status: "superseded" };
    start = leafIndex + 1;
  }
  const requestIndex = branch.findIndex(
    (entry, index) => index >= start && isUserEntryWithText(entry, options.requestText),
  );
  if (requestIndex === -1) return { status: "superseded" };

  let bestEntryId: string | null = null;
  for (const entry of branch.slice(requestIndex + 1))
    bestEntryId = considerAnswer(bestEntryId, entry);
  const answer =
    bestEntryId && options.sessionPath ? { path: options.sessionPath, entryId: bestEntryId } : null;
  return { status: "found", answer };
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
