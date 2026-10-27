import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChildRecord, createStore, type Store } from "./store.ts";

// Pass-through, so a test can make one write fail as a full disk would.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let root: string;
let store: Store;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-store-"));
  store = createStore(path.join(root, "subagents"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const childInput = {
  parent: { sessionId: "parent-session", name: "Parent" },
  worktree: "/repo",
  cwd: "/repo/pkg",
  agent: { name: "Code Scout", source: "user" as const, tools: ["read"] },
  projectTrust: true,
  label: "review",
  taskNumber: 1,
  depth: 1 as const,
  piCommand: ["/node", "/pi/cli.js"],
};

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

function overwrite(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value));
}

describe("children", () => {
  it("allocates a slugged child ID and writes child.json and system-prompt.md privately", () => {
    const child = store.createChild(childInput, "Be thorough.");

    expect(child.childId).toMatch(/^code-scout-[a-z2-7]{4}$/);
    const dir = store.childDir(child.childId);
    expect(dir).toBe(path.join(root, "subagents", "children", child.childId));
    expect(store.readChild(child.childId)).toEqual(child);
    expect(child).toMatchObject({ version: 1, ...childInput });
    expect(Number.isNaN(Date.parse(child.createdAt))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "system-prompt.md"), "utf8")).toBe("Be thorough.");
    expect(mode(dir)).toBe(0o700);
    // Pi would otherwise create the session directory with its default mode.
    expect(mode(path.join(dir, "session"))).toBe(0o700);
    expect(mode(path.join(dir, "child.json"))).toBe(0o600);
    expect(mode(path.join(dir, "system-prompt.md"))).toBe(0o600);
  });

  it("allocates distinct IDs for the same agent", () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => store.createChild(childInput, "").childId),
    );
    expect(ids.size).toBe(20);
  });

  it("falls back to a generic slug for an agent name without letters or digits", () => {
    const child = store.createChild(
      { ...childInput, agent: { ...childInput.agent, name: "!!" } },
      "",
    );
    expect(child.childId).toMatch(/^agent-[a-z2-7]{4}$/);
  });

  it("treats a version or identity mismatch as an error, not absence", () => {
    const child = store.createChild(childInput, "");
    const file = path.join(store.childDir(child.childId), "child.json");

    overwrite(file, { ...child, version: 2 });
    expect(() => store.readChild(child.childId)).toThrow(/child\.json/);
    overwrite(file, { ...child, childId: "other-aaaa" });
    expect(() => store.readChild(child.childId)).toThrow(/child\.json/);
    overwrite(file, { ...child, depth: 3 });
    expect(() => store.readChild(child.childId)).toThrow(/child\.json/);
    fs.writeFileSync(file, "{not json");
    expect(() => store.readChild(child.childId)).toThrow(/child\.json/);
  });

  it("refuses IDs that could address a path outside the state directory", () => {
    expect(() => store.readChild("../escape")).toThrow(/Invalid child ID/);
    expect(() => store.readResult({ childId: "ok-aaaa", requestId: "../r1" })).toThrow(
      /Invalid request ID/,
    );
  });

  it("reports a missing child as an error naming the child", () => {
    expect(() => store.readChild("ghost-aaaa")).toThrow(/ghost-aaaa/);
  });
});

describe("requests and results", () => {
  let child: ChildRecord;
  beforeEach(() => {
    child = store.createChild(childInput, "");
  });

  it("allocates r1, r2, … and lists them in numeric order", () => {
    const ids = Array.from(
      { length: 11 },
      (_, index) => store.createRequest(child.childId, `task ${index}`).request.requestId,
    );
    expect(ids[0]).toBe("r1");
    expect(ids[10]).toBe("r11");
    expect(store.listRequestIds(child.childId)).toEqual(ids);
  });

  it("leaves no request behind when writing it fails, so the next one is r1", () => {
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    expect(() => store.createRequest(child.childId, "Lost")).toThrow("ENOSPC");
    expect(store.listRequestIds(child.childId)).toEqual([]);
    expect(store.createRequest(child.childId, "Next").request.requestId).toBe("r1");
    expect(store.readRequest({ childId: child.childId, requestId: "r1" })).toMatchObject({
      instruction: "Next",
    });
  });

  it("writes request.json once with the instruction and reads it back", () => {
    const record = store.createRequest(child.childId, "Review the diff");
    const ref = { childId: child.childId, requestId: "r1" };

    expect(record).toMatchObject({ version: 1, request: ref, instruction: "Review the diff" });
    expect(store.readRequest(ref)).toEqual(record);
    expect(mode(path.join(store.childDir(child.childId), "requests", "r1", "request.json"))).toBe(
      0o600,
    );
  });

  it("returns undefined for a result that has not been written, then the written record", () => {
    store.createRequest(child.childId, "Review");
    const ref = { childId: child.childId, requestId: "r1" };
    expect(store.readResult(ref)).toBeUndefined();

    const running = {
      version: 1 as const,
      request: ref,
      nonce: "n1",
      phase: "running" as const,
      startedAt: new Date().toISOString(),
    };
    store.writeResult(running);
    expect(store.readResult(ref)).toEqual(running);

    const settled = {
      version: 1 as const,
      request: ref,
      nonce: "n1",
      phase: "settled" as const,
      settledAt: new Date().toISOString(),
      result: {
        status: "completed" as const,
        answer: { path: "/s.jsonl", entryId: "e1" },
        humanIntervened: false,
      },
    };
    store.writeResult(settled);
    expect(store.readResult(ref)).toEqual(settled);
  });

  it("rejects a result whose request reference does not match", () => {
    store.createRequest(child.childId, "Review");
    const ref = { childId: child.childId, requestId: "r1" };
    const file = path.join(store.childDir(child.childId), "requests", "r1", "result.json");
    overwrite(file, {
      version: 1,
      request: { childId: child.childId, requestId: "r2" },
      nonce: "n",
      phase: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() => store.readResult(ref)).toThrow(/result\.json/);
    overwrite(file, {
      version: 1,
      request: ref,
      nonce: "n",
      phase: "settled",
      settledAt: "2026-01-01T00:00:00.000Z",
      result: { status: "failed", reason: "bored", error: "x", humanIntervened: false },
    });
    expect(() => store.readResult(ref)).toThrow(/result\.json/);
  });
});

describe("status", () => {
  it("round-trips status.json and rejects an invalid one", () => {
    const child = store.createChild(childInput, "");
    expect(store.readStatus(child.childId)).toBeUndefined();

    const status = {
      version: 1 as const,
      nonce: "abc",
      pid: 42,
      state: "running" as const,
      current: "r1",
      blocked: { label: "Bash permission: waiting", since: "2026-01-01T00:00:00.000Z" },
    };
    store.writeStatus(child.childId, status);
    expect(store.readStatus(child.childId)).toEqual(status);

    overwrite(path.join(store.childDir(child.childId), "status.json"), { ...status, state: "x" });
    expect(() => store.readStatus(child.childId)).toThrow(/status\.json/);
  });
});

describe("reports", () => {
  let child: ChildRecord;
  const report = (content: string) => ({
    childId: child.childId,
    parentSessionId: "parent-session",
    agent: "Code Scout",
    content,
  });
  beforeEach(() => {
    child = store.createChild(childInput, "");
  });

  it("allocates m1, m2, … write-once and lists them in numeric order", () => {
    expect(store.listReportIds(child.childId)).toEqual([]);
    const ids = Array.from(
      { length: 11 },
      (_, index) => store.createReport(report(`finding ${index}`)).reportId,
    );
    expect(ids[0]).toBe("m1");
    expect(ids[10]).toBe("m11");
    expect(store.listReportIds(child.childId)).toEqual(ids);

    const first = store.readReport(child.childId, "m1");
    expect(first).toMatchObject({ version: 1, reportId: "m1", ...report("finding 0") });
    expect(Number.isNaN(Date.parse(first?.createdAt ?? ""))).toBe(false);
    const file = path.join(store.childDir(child.childId), "reports", "m1.json");
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
  });

  it("returns undefined for an absent report and rejects one whose identity does not match", () => {
    expect(store.readReport(child.childId, "m1")).toBeUndefined();
    const record = store.createReport(report("x"));
    const file = path.join(store.childDir(child.childId), "reports", "m1.json");

    overwrite(file, { ...record, reportId: "m2" });
    expect(() => store.readReport(child.childId, "m1")).toThrow(/m1\.json/);
    overwrite(file, { ...record, childId: "other-aaaa" });
    expect(() => store.readReport(child.childId, "m1")).toThrow(/m1\.json/);
    overwrite(file, { ...record, content: 3 });
    expect(() => store.readReport(child.childId, "m1")).toThrow(/m1\.json/);
    expect(() => store.readReport(child.childId, "../m1")).toThrow(/report ID/);
  });

  it("lists child IDs, empty before any child exists", () => {
    expect(createStore(path.join(root, "empty")).listChildIds()).toEqual([]);
    const other = store.createChild(childInput, "");
    expect(store.listChildIds().sort()).toEqual([child.childId, other.childId].sort());
  });
});

describe("tmux.conf", () => {
  it("writes the private server configuration under the root", () => {
    const file = store.writeTmuxConf("set -g status off\n");
    expect(file).toBe(path.join(root, "subagents", "tmux.conf"));
    expect(fs.readFileSync(file, "utf8")).toBe("set -g status off\n");
    expect(mode(file)).toBe(0o600);
  });
});
