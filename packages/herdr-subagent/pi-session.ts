import * as fs from "node:fs";

/** Minimal shape of a session JSONL message entry. */
interface SessionMessageEntry {
	type?: string;
	message?: {
		role?: string;
		stopReason?: string;
		content?: Array<{ type?: string; text?: string }>;
	};
}

/** Extracted final answer from a Pi session file. */
export interface SessionAnswer {
	text: string;
}

/**
 * Read a Pi session `.jsonl` file and extract the last substantive assistant
 * message whose stop reason is terminal (`stop` or `end_turn`, not `toolUse`).
 *
 * The concatenated text parts from that message are returned. Later substantive
 * terminal messages replace earlier ones; a later whitespace-only terminal
 * message is ignored when a substantive answer was already found. Returns
 * `null` if no terminal assistant message is found (file missing, empty, or
 * child still working).
 */
export function readSessionAnswer(sessionPath: string): SessionAnswer | null {
	let content: string;
	try {
		content = fs.readFileSync(sessionPath, "utf-8");
	} catch {
		return null;
	}

	let finalAnswer: string | null = null;

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;

		let entry: SessionMessageEntry;
		try {
			entry = JSON.parse(line) as SessionMessageEntry;
		} catch {
			continue;
		}

		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (!msg || msg.role !== "assistant") continue;

		const stopReason: string = msg.stopReason ?? "";
		if (stopReason !== "stop" && stopReason !== "end_turn") continue;

		// Terminal assistant message — prefer the latest substantive text.
		let messageText = "";
		const parts = Array.isArray(msg.content) ? msg.content : [];
		for (const part of parts) {
			if (part?.type === "text" && typeof part.text === "string") {
				messageText += part.text;
			}
		}
		if (messageText.trim()) {
			finalAnswer = messageText;
		} else if (finalAnswer === null && messageText.length > 0) {
			// Preserve whitespace-only text if we have nothing better yet.
			finalAnswer = messageText;
		}
	}

	if (finalAnswer === null) return null;
	return { text: finalAnswer };
}
