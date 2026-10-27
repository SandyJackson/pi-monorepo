import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRequestAnswer, readAnswer } from "./pi-session.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeSessionFile(fileName: string, content: string): string {
  const sessionPath = path.join(tempDir, fileName);
  fs.writeFileSync(sessionPath, content, "utf-8");
  return sessionPath;
}

function jsonl(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

const header = { type: "session", id: "session-1", cwd: "/c", timestamp: "x" };

function user(id: string, text: string) {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(id: string, content: unknown, stopReason = "stop") {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return { type: "message", id, message: { role: "assistant", stopReason, content: parts } };
}

describe("readAnswer", () => {
  it("resolves the referenced terminal assistant entry, even after later appends", () => {
    const sessionPath = writeSessionFile(
      "later.jsonl",
      jsonl(header, assistant("message-1", "first")),
    );
    fs.appendFileSync(
      sessionPath,
      jsonl(user("message-2", "next"), assistant("message-3", "second")),
    );

    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBe("first");
    expect(readAnswer({ path: sessionPath, entryId: "message-3" })).toBe("second");
  });

  it("concatenates text blocks in stored order and accepts string content", () => {
    const sessionPath = writeSessionFile(
      "concat.jsonl",
      jsonl(
        header,
        assistant("message-1", [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
          { type: "thinking", text: "ignored" },
        ]),
        {
          type: "message",
          id: "message-2",
          message: { role: "assistant", stopReason: "end_turn", content: "string answer" },
        },
      ),
    );

    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBe("hello world");
    expect(readAnswer({ path: sessionPath, entryId: "message-2" })).toBe("string answer");
  });

  it("is null for an entry that is not a terminal assistant message with text", () => {
    const sessionPath = writeSessionFile(
      "invalid.jsonl",
      jsonl(
        header,
        assistant("tool-use", "hi", "toolUse"),
        {
          type: "message",
          id: "user",
          message: { role: "user", stopReason: "stop", content: "hi" },
        },
        assistant("empty", []),
        { type: "message", id: "no-message" },
      ),
    );

    for (const entryId of ["tool-use", "user", "empty", "no-message", "nonexistent"]) {
      expect(readAnswer({ path: sessionPath, entryId })).toBeNull();
    }
  });

  it("skips malformed, primitive, and oversized lines, never parsing a suffix of one", () => {
    const injected = JSON.stringify(assistant("message-1", "injected"));
    const sessionPath = writeSessionFile(
      "noise.jsonl",
      'null\n42\n"hi"\n[]\nnot json\n{ bad\n' +
        jsonl(header) +
        `${"a".repeat(1024 * 1024 + 100)}${injected}\n` +
        jsonl(assistant("message-2", "real")) +
        "a".repeat(1024 * 1024 + 10),
    );

    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBeNull();
    expect(readAnswer({ path: sessionPath, entryId: "message-2" })).toBe("real");
  });

  it("is null for a missing or deleted session file", () => {
    const sessionPath = writeSessionFile(
      "deleted.jsonl",
      jsonl(header, assistant("message-1", "hi")),
    );
    fs.rmSync(sessionPath);

    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBeNull();
    expect(readAnswer({ path: "/no/such/file.jsonl", entryId: "x" })).toBeNull();
  });
});

describe("findRequestAnswer on the active branch", () => {
  const sessionPath = "/sessions/child.jsonl";
  const answerOf = (branch: unknown[]) =>
    findRequestAnswer([user("u1", "Go"), ...branch], {
      dispatchLeaf: null,
      requestText: "Go",
      sessionPath,
    });

  it("selects the latest substantive terminal answer after the request entry", () => {
    const branch = [
      user("u0", "Review"),
      assistant("a0", "Earlier answer"),
      { type: "system", id: "s1" },
      user("u1", "Review"),
      assistant("a1", "First"),
      user("u2", "operator follow-up"),
      assistant("a2", "Latest"),
      assistant("a3", "  "),
      assistant("a4", "Aborted", "aborted"),
    ];

    expect(
      findRequestAnswer(branch, { dispatchLeaf: "a0", requestText: "Review", sessionPath }),
    ).toEqual({ status: "found", answer: { path: sessionPath, entryId: "a2" } });
  });

  it("falls back to the first whitespace-only answer when there is no substantive one", () => {
    expect(answerOf([assistant("a1", " \t"), assistant("a2", "  ")])).toEqual({
      status: "found",
      answer: { path: sessionPath, entryId: "a1" },
    });
  });

  it("treats end_turn as terminal, and tool use, empty content, or a blank ID as no answer", () => {
    expect(answerOf([assistant("a1", "done", "end_turn")])).toMatchObject({
      answer: { entryId: "a1" },
    });
    expect(
      answerOf([assistant("a1", "hi", "toolUse"), assistant("a2", []), assistant("   ", "hi")]),
    ).toEqual({ status: "found", answer: null });
  });

  it("starts from the branch root when the session was empty at dispatch", () => {
    expect(answerOf([assistant("a1", "Done")])).toEqual({
      status: "found",
      answer: { path: sessionPath, entryId: "a1" },
    });
  });

  it("reports a request entry with no terminal answer as found without an answer", () => {
    expect(answerOf([])).toEqual({ status: "found", answer: null });
  });

  it("is superseded when the dispatch point or the request entry is not on the branch", () => {
    const branch = [user("u0", "Go"), assistant("a0", "Done")];
    expect(
      findRequestAnswer(branch, { dispatchLeaf: "elsewhere", requestText: "Go", sessionPath }),
    ).toEqual({ status: "superseded" });
    expect(
      findRequestAnswer(branch, { dispatchLeaf: "a0", requestText: "Go", sessionPath }),
    ).toEqual({ status: "superseded" });
  });
});
