import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectSession, readAnswer } from "./pi-session.ts";

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

describe("pi-session Pi identity", () => {
  it("first available path plus valid header yields Pi session id, absolute path, and cwd atomically", () => {
    const sessionPath = writeSessionFile(
      "valid.jsonl",
      jsonl(
        {
          type: "session",
          id: "sess-xyz",
          cwd: "/tmp/project",
          timestamp: "2024-01-01T00:00:00.000Z",
        },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "2024-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ),
    );
    const snapshot = inspectSession(sessionPath);
    expect(snapshot.pi).toEqual({ id: "sess-xyz", path: sessionPath, cwd: "/tmp/project" });
  });

  it("malformed header — first entry not session — yields no pi", () => {
    const sessionPath = writeSessionFile(
      "malformed_header.jsonl",
      jsonl({
        type: "message",
        id: "message-1",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
      }),
    );
    const snapshot = inspectSession(sessionPath);
    expect(snapshot.pi).toBeNull();
  });

  it("partial header — truncated JSON — yields no pi and no answer", () => {
    const sessionPath = path.join(tempDir, "partial.jsonl");
    fs.writeFileSync(sessionPath, '{"type":"session","id":"sess-123"', "utf-8");
    const snapshot = inspectSession(sessionPath);
    expect(snapshot.pi).toBeNull();
    expect(snapshot.answer).toBeNull();
  });

  it("header missing id yields no pi", () => {
    const sessionPath = writeSessionFile(
      "missing_id.jsonl",
      jsonl(
        { type: "session", cwd: "/tmp", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ),
    );
    expect(inspectSession(sessionPath).pi).toBeNull();
  });

  it("header missing cwd yields no pi", () => {
    const sessionPath = writeSessionFile(
      "missing_cwd.jsonl",
      jsonl(
        { type: "session", id: "session-1", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ),
    );
    expect(inspectSession(sessionPath).pi).toBeNull();
  });

  it("header with empty or whitespace id/cwd yields no pi", () => {
    const emptyId = writeSessionFile(
      "empty_id.jsonl",
      jsonl({ type: "session", id: "", cwd: "/c", timestamp: "x" }),
    );
    expect(inspectSession(emptyId).pi).toBeNull();
    const wsId = writeSessionFile(
      "ws_id.jsonl",
      jsonl({ type: "session", id: "   ", cwd: "/c", timestamp: "x" }),
    );
    expect(inspectSession(wsId).pi).toBeNull();
    const emptyCwd = writeSessionFile(
      "empty_cwd.jsonl",
      jsonl({ type: "session", id: "s1", cwd: "", timestamp: "x" }),
    );
    expect(inspectSession(emptyCwd).pi).toBeNull();
    const wsCwd = writeSessionFile(
      "ws_cwd.jsonl",
      jsonl({ type: "session", id: "s1", cwd: "   ", timestamp: "x" }),
    );
    expect(inspectSession(wsCwd).pi).toBeNull();
  });

  it("blank lines before valid header are skipped, but malformed first header yields no pi", () => {
    const withBlanks = writeSessionFile(
      "skip_blanks.jsonl",
      `   \n\n${jsonl({ type: "session", id: "session-2", cwd: "/cwd2", timestamp: "x" })}`,
    );
    expect(inspectSession(withBlanks).pi?.id).toBe("session-2");

    const malformedFirst = writeSessionFile(
      "skip_malformed.jsonl",
      `not json\n${jsonl({ type: "session", id: "session-2", cwd: "/cwd2", timestamp: "x" })}`,
    );
    expect(inspectSession(malformedFirst).pi).toBeNull();
  });

  it("null, array, and primitive JSON lines do not throw and are skipped", () => {
    const sessionPath = writeSessionFile(
      "primitive_lines.jsonl",
      'null\n42\n"string"\n[]\n' +
        jsonl({ type: "session", id: "session-1", cwd: "/c", timestamp: "x" }) +
        "null\n" +
        jsonl({
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        }),
    );
    // First non-blank line is 'null' (valid JSON but not record) → header is malformed → pi null, but answer scanning still finds terminal message
    expect(inspectSession(sessionPath).pi).toBeNull();
    expect(inspectSession(sessionPath).answer?.entryId).toBe("message-1");
    // Clean header with primitives interleaved before answer should still capture answer
    const cleanPath = writeSessionFile(
      "primitive_answer.jsonl",
      jsonl({ type: "session", id: "session-1", cwd: "/c", timestamp: "x" }) +
        "null\n42\n" +
        jsonl({
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        }),
    );
    expect(inspectSession(cleanPath).answer?.entryId).toBe("message-1");
    expect(readAnswer({ path: cleanPath, entryId: "message-1" })).toBe("hi");
  });

  it("oversized line (>1MiB) is skipped and does not hide following valid entries", () => {
    const oversized = "a".repeat(1024 * 1024 + 10);
    const sessionPath = writeSessionFile(
      "oversized.jsonl",
      oversized +
        "\n" +
        jsonl(
          { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
          {
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "x",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "hi" }],
            },
          },
        ),
    );
    expect(inspectSession(sessionPath).pi).toBeNull(); // first non-blank is oversized → header malformed
    // Valid answer after oversized line should still be found when header is valid
    const validAfterOversized = writeSessionFile(
      "oversized_then_valid.jsonl",
      jsonl({ type: "session", id: "session-1", cwd: "/c", timestamp: "x" }) +
        oversized +
        "\n" +
        jsonl({
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        }),
    );
    expect(inspectSession(validAfterOversized).answer?.entryId).toBe("message-1");
    // Multibyte oversized (é = 2 bytes) — 600k é = ~1.2MiB
    const multiOversized = "é".repeat(600 * 1024);
    const multiPath = writeSessionFile(
      "multi_oversized.jsonl",
      multiOversized +
        "\n" +
        jsonl({ type: "session", id: "session-1", cwd: "/c", timestamp: "x" }),
    );
    expect(inspectSession(multiPath).pi).toBeNull();
  });

  it("oversized physical line with valid JSON suffix on same line is fully discarded", () => {
    const padding = "a".repeat(1024 * 1024 + 100);
    const validSuffix = JSON.stringify({
      type: "message",
      id: "message-1",
      parentId: null,
      timestamp: "x",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "injected" }],
      },
    });
    const oversizedWithSuffix = padding + validSuffix; // same physical line, no newline between padding and JSON
    const sessionPath = writeSessionFile(
      "oversized_suffix.jsonl",
      jsonl({ type: "session", id: "session-1", cwd: "/c", timestamp: "x" }) +
        oversizedWithSuffix +
        "\n" +
        jsonl({
          type: "message",
          id: "message-2",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "real" }],
          },
        }),
    );
    // The oversized line (even though it ends with valid JSON) must be discarded entirely
    expect(inspectSession(sessionPath).answer?.entryId).toBe("message-2");
    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBeNull();
  });

  it("oversized final line without trailing newline is discarded", () => {
    const oversizedNoNewline = "a".repeat(1024 * 1024 + 10);
    const sessionPath = writeSessionFile(
      "oversized_eof.jsonl",
      jsonl({ type: "session", id: "session-1", cwd: "/c", timestamp: "x" }) + oversizedNoNewline,
    );
    // No valid answer after oversized EOF line
    expect(inspectSession(sessionPath).answer).toBeNull();
    // Valid entry before oversized EOF should still be found (oversized tail ignored)
    const withValidBefore = writeSessionFile(
      "valid_before_oversized_eof.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ) + oversizedNoNewline,
    );
    expect(inspectSession(withValidBefore).answer?.entryId).toBe("message-1");
  });

  it("missing file yields null pi and answer", () => {
    const missingPath = path.join(tempDir, "nope.jsonl");
    const snapshot = inspectSession(missingPath);
    expect(snapshot.pi).toBeNull();
    expect(snapshot.answer).toBeNull();
    expect(readAnswer({ path: missingPath, entryId: "x" })).toBeNull();
  });
});

describe("pi-session answer reference capture", () => {
  it("stable settlement can capture exact {path, entryId} or explicit absence", () => {
    const sessionPath = writeSessionFile(
      "capture.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "first" }],
          },
        },
      ),
    );
    const snapshot = inspectSession(sessionPath);
    expect(snapshot.answer).toEqual({ path: sessionPath, entryId: "message-1" });

    const emptyPath = writeSessionFile(
      "answerless.jsonl",
      jsonl({ type: "session", id: "session-1", cwd: "/c", timestamp: "x" }),
    );
    expect(inspectSession(emptyPath).answer).toBeNull();
  });

  it("preserves substantive/whitespace selection: latest substantive wins, whitespace only if no substantive", () => {
    const sessionPath = writeSessionFile(
      "selection.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "   " }],
          },
        },
        {
          type: "message",
          id: "message-2",
          parentId: "message-1",
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "real" }],
          },
        },
        {
          type: "message",
          id: "message-3",
          parentId: "message-2",
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "   " }],
          },
        },
      ),
    );
    expect(inspectSession(sessionPath).answer?.entryId).toBe("message-2");
    expect(readAnswer({ path: sessionPath, entryId: "message-2" })).toBe("real");

    const whitespaceOnlyPath = writeSessionFile(
      "ws_only.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "   \t" }],
          },
        },
      ),
    );
    const whitespaceSnapshot = inspectSession(whitespaceOnlyPath);
    expect(whitespaceSnapshot.answer?.entryId).toBe("message-1");
    expect(readAnswer(whitespaceSnapshot.answer!)).toBe("   \t");
  });

  it("whitespace-only answer is explicit absence when no text", () => {
    const sessionPath = writeSessionFile(
      "no_text.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: { role: "assistant", stopReason: "stop", content: [] },
        },
      ),
    );
    expect(inspectSession(sessionPath).answer).toBeNull();
  });

  it("no terminal answer yields null", () => {
    const sessionPath = writeSessionFile(
      "no_terminal.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "text", text: "hi" }],
          },
        },
        {
          type: "message",
          id: "message-2",
          parentId: "message-1",
          timestamp: "x",
          message: { role: "user", content: "hi" },
        },
      ),
    );
    expect(inspectSession(sessionPath).answer).toBeNull();
  });

  it("end_turn is treated as terminal like stop", () => {
    const sessionPath = writeSessionFile(
      "end_turn.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "end_turn",
            content: [{ type: "text", text: "done" }],
          },
        },
      ),
    );
    expect(inspectSession(sessionPath).answer?.entryId).toBe("message-1");
    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBe("done");
  });

  it("requires nonempty persisted id", () => {
    const sessionPath = writeSessionFile(
      "no_id.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
        {
          type: "message",
          id: "",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi2" }],
          },
        },
        {
          type: "message",
          id: "   ",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi3" }],
          },
        },
      ),
    );
    expect(inspectSession(sessionPath).answer).toBeNull();
  });

  it("concatenates text blocks in stored order", () => {
    const sessionPath = writeSessionFile(
      "concat.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
              { type: "thinking", text: "ignored" },
            ],
          },
        },
      ),
    );
    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBe("hello world");
  });

  it("handles string content", () => {
    const sessionPath = writeSessionFile(
      "string_content.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: { role: "assistant", stopReason: "stop", content: "string answer" },
        },
      ),
    );
    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBe("string answer");
  });

  it("malformed lines are skipped", () => {
    const content =
      jsonl({ type: "session", id: "session-1", cwd: "/c", timestamp: "x" }) +
      "not json\n" +
      jsonl({
        type: "message",
        id: "message-1",
        parentId: null,
        timestamp: "x",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
      }) +
      "\n   \n{ bad\n";
    const sessionPath = writeSessionFile("malformed_lines.jsonl", content);
    expect(inspectSession(sessionPath).answer?.entryId).toBe("message-1");
  });

  it("empty text returns null on resolve", () => {
    const sessionPath = writeSessionFile(
      "empty_text.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: { role: "assistant", stopReason: "stop", content: [] },
        },
      ),
    );
    // Empty text is not captured, but if resolved directly should be null
    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBeNull();
  });
});

describe("pi-session resolution", () => {
  it("resolution finds only that persisted entry after later appends/branches", () => {
    const sessionPath = writeSessionFile(
      "later.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "first" }],
          },
        },
      ),
    );
    const snapshot1 = inspectSession(sessionPath);
    fs.appendFileSync(
      sessionPath,
      jsonl(
        {
          type: "message",
          id: "message-2",
          parentId: "message-1",
          timestamp: "x",
          message: { role: "user", content: "next" },
        },
        {
          type: "message",
          id: "message-3",
          parentId: "message-2",
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "second" }],
          },
        },
      ),
    );
    const snapshot2 = inspectSession(sessionPath);
    expect(snapshot1.answer).toEqual({ path: sessionPath, entryId: "message-1" });
    expect(snapshot2.answer).toEqual({ path: sessionPath, entryId: "message-3" });
    expect(readAnswer(snapshot1.answer!)).toBe("first");
    expect(readAnswer(snapshot2.answer!)).toBe("second");
    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBe("first");
  });

  it("resolving a reference validates exact entry is still terminal assistant message", () => {
    const sessionPath = writeSessionFile(
      "validate.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ),
    );
    expect(readAnswer({ path: sessionPath, entryId: "message-1" })).toBe("hi");

    const failPath = writeSessionFile(
      "validate_fail.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ),
    );
    expect(readAnswer({ path: failPath, entryId: "message-1" })).toBeNull();
  });

  it("missing referenced entry yields null", () => {
    const sessionPath = writeSessionFile(
      "missing_ref.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ),
    );
    expect(readAnswer({ path: sessionPath, entryId: "nonexistent" })).toBeNull();
  });

  it("malformed referenced entry yields null", () => {
    // Entry with matching ID but wrong role / missing stopReason / malformed content
    const wrongRolePath = writeSessionFile(
      "wrong_role.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: { role: "user", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
        },
      ),
    );
    expect(readAnswer({ path: wrongRolePath, entryId: "message-1" })).toBeNull();

    const emptyContentPath = writeSessionFile(
      "empty_content.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: { role: "assistant", stopReason: "stop", content: [] },
        },
      ),
    );
    expect(readAnswer({ path: emptyContentPath, entryId: "message-1" })).toBeNull();

    const noMessagePath = writeSessionFile(
      "no_message.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        { type: "message", id: "message-1", parentId: null, timestamp: "x" },
      ),
    );
    expect(readAnswer({ path: noMessagePath, entryId: "message-1" })).toBeNull();

    // Malformed line for non-existent id is still missing
    const basePath = writeSessionFile(
      "malformed_ref.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ),
    );
    fs.appendFileSync(basePath, "not json for message-2\n");
    expect(readAnswer({ path: basePath, entryId: "message-2" })).toBeNull();
  });

  it("deleted file after capture yields null", () => {
    const sessionPath = writeSessionFile(
      "deleted.jsonl",
      jsonl(
        { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "x",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "hi" }],
          },
        },
      ),
    );
    const snapshot = inspectSession(sessionPath);
    fs.rmSync(sessionPath);
    expect(readAnswer(snapshot.answer!)).toBeNull();
    expect(inspectSession(sessionPath).answer).toBeNull();
  });

  it("failure to resolve does not throw", () => {
    expect(() => readAnswer({ path: "/no/such/file.jsonl", entryId: "x" })).not.toThrow();
    expect(() => inspectSession("/no/such/file.jsonl")).not.toThrow();
    expect(() => inspectSession("/no/such/file.jsonl")).not.toThrow();
  });

  it("primitive JSON lines in file do not throw on inspection or resolution", () => {
    const sessionPath = writeSessionFile(
      "primitives.jsonl",
      'null\n42\n"hi"\n[]\n' +
        jsonl(
          { type: "session", id: "session-1", cwd: "/c", timestamp: "x" },
          {
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "x",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "hi" }],
            },
          },
        ),
    );
    expect(() => inspectSession(sessionPath)).not.toThrow();
    expect(() => readAnswer({ path: sessionPath, entryId: "message-1" })).not.toThrow();
  });
});
