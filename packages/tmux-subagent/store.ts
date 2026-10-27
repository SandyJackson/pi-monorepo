/**
 * store.ts — the subagent state directory (§4): paths, ID allocation,
 * write-to-temp-then-rename, and validation of every §5 record.
 *
 * Each file has one writer. Readers validate shape and identity, and treat a
 * mismatch as an error, never as absence. Only a missing file is absence.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionAnswerRef } from "./pi-session.ts";

// ---------------------------------------------------------------------------
// Records (§5)
// ---------------------------------------------------------------------------

export type ChildId = string;
export type RequestId = string;
export type ReportId = string;

export interface RequestRef {
  childId: ChildId;
  requestId: RequestId;
}

/** child.json */
export interface ChildRecord {
  version: 1;
  childId: ChildId;
  createdAt: string;
  parent: { sessionId: string; name?: string };
  worktree: string;
  cwd: string;
  agent: {
    name: string;
    source: "workspace" | "user" | "project";
    model?: string;
    thinking?: string;
    tools?: string[];
    timeoutMinutes?: number;
  };
  projectTrust: boolean;
  label?: string;
  taskNumber?: number;
  depth: 1 | 2;
  piCommand: string[];
}

/** requests/<id>/request.json */
export interface RequestRecord {
  version: 1;
  request: RequestRef;
  instruction: string;
  submittedAt: string;
}

/** The child-recorded terminal result of one request. Final once written. */
export type RequestResult =
  | { status: "completed"; answer: SessionAnswerRef | null; humanIntervened: boolean }
  | {
      status: "failed";
      reason: "error" | "interrupted" | "superseded";
      error: string;
      humanIntervened: boolean;
    };

/** requests/<id>/result.json */
export type ResultRecord =
  | { version: 1; request: RequestRef; nonce: string; phase: "running"; startedAt: string }
  | {
      version: 1;
      request: RequestRef;
      nonce: string;
      phase: "settled";
      settledAt: string;
      result: RequestResult;
    };

/** status.json */
export interface StatusRecord {
  version: 1;
  nonce: string;
  pid: number;
  state: "idle" | "running";
  current?: RequestId;
  blocked?: { label: string; since: string };
}

/** reports/<id>.json */
export interface ReportRecord {
  version: 1;
  childId: ChildId;
  reportId: ReportId;
  /** Copied from child.json by the bridge, never from the model. */
  parentSessionId: string;
  agent: string;
  createdAt: string;
  content: string;
}

export type NewReport = Omit<ReportRecord, "version" | "reportId" | "createdAt">;

export type NewChild = Omit<ChildRecord, "version" | "childId" | "createdAt">;

export interface Store {
  readonly root: string;
  childDir(childId: ChildId): string;
  /** Allocate a child ID by exclusive `mkdir`, then write child.json and system-prompt.md. */
  createChild(child: NewChild, systemPrompt: string): ChildRecord;
  readChild(childId: ChildId): ChildRecord;
  /** Allocate the next request ID by exclusive `mkdir`, then write request.json. */
  createRequest(childId: ChildId, instruction: string): RequestRecord;
  readRequest(ref: RequestRef): RequestRecord | undefined;
  /** Request IDs of a child in numeric order. */
  listRequestIds(childId: ChildId): RequestId[];
  readResult(ref: RequestRef): ResultRecord | undefined;
  writeResult(record: ResultRecord): void;
  readStatus(childId: ChildId): StatusRecord | undefined;
  writeStatus(childId: ChildId, record: StatusRecord): void;
  /** Child IDs found in the children directory, in no particular order. */
  listChildIds(): ChildId[];
  /** Allocate the next report ID and write the report, never replacing one. */
  createReport(report: NewReport): ReportRecord;
  /** Report IDs of a child in numeric order. */
  listReportIds(childId: ChildId): ReportId[];
  readReport(childId: ChildId, reportId: ReportId): ReportRecord | undefined;
  /** Rewrite tmux.conf and return its path. */
  writeTmuxConf(content: string): string;
}

/** `~/.pi/agent/subagents`, following Pi's agent directory (`PI_CODING_AGENT_DIR`). */
export function defaultStoreRoot(): string {
  return path.join(getAgentDir(), "subagents");
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const MAX_ID_ATTEMPTS = 64;
const MAX_SLUG_LENGTH = 24;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isTaken(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function writeAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: FILE_MODE, flag: "wx" });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function writeJson(file: string, value: unknown): void {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write a complete file under a name that must not exist yet; false when it does. */
function writeJsonOnce(file: string, value: unknown): boolean {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
    // A hard link, unlike rename, refuses to replace an existing file.
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if (isTaken(error)) return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Parse and validate a record; `undefined` only when the file is absent. */
function readJson<T>(
  file: string,
  validate: (value: unknown) => string | undefined,
): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${file}: not JSON`);
  }
  const problem = validate(value);
  if (problem) throw new Error(`Invalid ${file}: ${problem}`);
  return value as T;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isOptionalString = (value: unknown) => value === undefined || isString(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

function sameRef(value: unknown, ref: RequestRef): boolean {
  return isObject(value) && value.childId === ref.childId && value.requestId === ref.requestId;
}

function checkChild(childId: ChildId) {
  return (value: unknown): string | undefined => {
    if (!isObject(value) || value.version !== 1) return "expected version 1";
    if (value.childId !== childId) return `childId is not ${childId}`;
    const parent = value.parent;
    if (!isObject(parent) || !isString(parent.sessionId) || !isOptionalString(parent.name)) {
      return "invalid parent";
    }
    if (!isString(value.createdAt) || !isString(value.worktree) || !isString(value.cwd)) {
      return "invalid createdAt, worktree or cwd";
    }
    const agent = value.agent;
    if (
      !isObject(agent) ||
      !isString(agent.name) ||
      !["workspace", "user", "project"].includes(agent.source as string) ||
      !isOptionalString(agent.model) ||
      !isOptionalString(agent.thinking) ||
      !(agent.tools === undefined || (Array.isArray(agent.tools) && agent.tools.every(isString))) ||
      !(agent.timeoutMinutes === undefined || Number.isInteger(agent.timeoutMinutes))
    ) {
      return "invalid agent";
    }
    if (!isBoolean(value.projectTrust)) return "invalid projectTrust";
    if (!isOptionalString(value.label)) return "invalid label";
    if (!(value.taskNumber === undefined || Number.isInteger(value.taskNumber))) {
      return "invalid taskNumber";
    }
    if (value.depth !== 1 && value.depth !== 2) return "invalid depth";
    if (!Array.isArray(value.piCommand) || !value.piCommand.every(isString)) {
      return "invalid piCommand";
    }
    return undefined;
  };
}

function checkRequest(ref: RequestRef) {
  return (value: unknown): string | undefined => {
    if (!isObject(value) || value.version !== 1) return "expected version 1";
    if (!sameRef(value.request, ref)) return "request reference mismatch";
    if (!isString(value.instruction) || !isString(value.submittedAt)) {
      return "invalid instruction or submittedAt";
    }
    return undefined;
  };
}

function checkRequestResult(value: unknown): string | undefined {
  if (!isObject(value) || !isBoolean(value.humanIntervened)) return "invalid result";
  if (value.status === "completed") {
    const answer = value.answer;
    if (answer === null) return undefined;
    return isObject(answer) && isString(answer.path) && isString(answer.entryId)
      ? undefined
      : "invalid answer";
  }
  if (value.status === "failed") {
    return ["error", "interrupted", "superseded"].includes(value.reason as string) &&
      isString(value.error)
      ? undefined
      : "invalid failure";
  }
  return "invalid result status";
}

function checkResult(ref: RequestRef) {
  return (value: unknown): string | undefined => {
    if (!isObject(value) || value.version !== 1) return "expected version 1";
    if (!sameRef(value.request, ref)) return "request reference mismatch";
    if (!isString(value.nonce)) return "invalid nonce";
    if (value.phase === "running")
      return isString(value.startedAt) ? undefined : "invalid startedAt";
    if (value.phase === "settled") {
      return isString(value.settledAt) ? checkRequestResult(value.result) : "invalid settledAt";
    }
    return "invalid phase";
  };
}

function checkStatus(value: unknown): string | undefined {
  if (!isObject(value) || value.version !== 1) return "expected version 1";
  if (!isString(value.nonce) || !Number.isInteger(value.pid)) return "invalid nonce or pid";
  if (value.state !== "idle" && value.state !== "running") return "invalid state";
  if (!isOptionalString(value.current)) return "invalid current";
  const blocked = value.blocked;
  if (
    blocked !== undefined &&
    !(isObject(blocked) && isString(blocked.label) && isString(blocked.since))
  ) {
    return "invalid blocked";
  }
  return undefined;
}

function checkReport(childId: ChildId, reportId: ReportId) {
  return (value: unknown): string | undefined => {
    if (!isObject(value) || value.version !== 1) return "expected version 1";
    if (value.childId !== childId || value.reportId !== reportId) return "report identity mismatch";
    if (
      !isString(value.parentSessionId) ||
      !isString(value.agent) ||
      !isString(value.createdAt) ||
      !isString(value.content)
    ) {
      return "invalid parentSessionId, agent, createdAt or content";
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function agentSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || "agent";
}

function randomSuffix(): string {
  return Array.from(randomBytes(4), (byte) => BASE32[byte % 32]).join("");
}

function requestNumber(requestId: string): number | undefined {
  const match = /^r([1-9][0-9]*)$/.exec(requestId);
  return match ? Number(match[1]) : undefined;
}

function reportNumber(reportId: string): number | undefined {
  const match = /^m([1-9][0-9]*)$/.exec(reportId);
  return match ? Number(match[1]) : undefined;
}

/** Directory entries, or none when the directory does not exist. */
function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export function createStore(root: string = defaultStoreRoot()): Store {
  const childrenDir = path.join(root, "children");
  // IDs can come from the model in later tools; never let one leave the root.
  const childDir = (childId: ChildId) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(childId)) throw new Error(`Invalid child ID: ${childId}`);
    return path.join(childrenDir, childId);
  };
  const requestDir = (ref: RequestRef) => {
    if (requestNumber(ref.requestId) === undefined) {
      throw new Error(`Invalid request ID: ${ref.requestId}`);
    }
    return path.join(childDir(ref.childId), "requests", ref.requestId);
  };

  const reportFile = (childId: ChildId, reportId: ReportId) => {
    if (reportNumber(reportId) === undefined) throw new Error(`Invalid report ID: ${reportId}`);
    return path.join(childDir(childId), "reports", `${reportId}.json`);
  };

  function listReportIds(childId: ChildId): ReportId[] {
    return readDir(path.join(childDir(childId), "reports"))
      .map((name) => name.replace(/\.json$/, ""))
      .filter((id) => reportNumber(id) !== undefined)
      .sort((a, b) => (reportNumber(a) ?? 0) - (reportNumber(b) ?? 0));
  }

  function listRequestIds(childId: ChildId): RequestId[] {
    return readDir(path.join(childDir(childId), "requests"))
      .filter((name) => requestNumber(name) !== undefined)
      .sort((a, b) => (requestNumber(a) ?? 0) - (requestNumber(b) ?? 0));
  }

  return {
    root,
    childDir,

    createChild(child, systemPrompt) {
      fs.mkdirSync(childrenDir, { recursive: true, mode: DIR_MODE });
      const slug = agentSlug(child.agent.name);
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
        const childId = `${slug}-${randomSuffix()}`;
        try {
          fs.mkdirSync(childDir(childId), { mode: DIR_MODE });
        } catch (error) {
          if (isTaken(error)) continue;
          throw error;
        }
        const record: ChildRecord = {
          version: 1,
          childId,
          createdAt: new Date().toISOString(),
          ...child,
        };
        // Created here so Pi's session directory is private like the rest of the state.
        fs.mkdirSync(path.join(childDir(childId), "session"), { mode: DIR_MODE });
        writeAtomic(path.join(childDir(childId), "system-prompt.md"), systemPrompt);
        writeJson(path.join(childDir(childId), "child.json"), record);
        return record;
      }
      throw new Error(
        `Could not allocate a child ID for ${slug} after ${MAX_ID_ATTEMPTS} attempts.`,
      );
    },

    readChild(childId) {
      const record = readJson<ChildRecord>(
        path.join(childDir(childId), "child.json"),
        checkChild(childId),
      );
      if (!record) throw new Error(`Child ${childId} does not exist.`);
      return record;
    },

    createRequest(childId, instruction) {
      const requestsDir = path.join(childDir(childId), "requests");
      fs.mkdirSync(requestsDir, { recursive: true, mode: DIR_MODE });
      for (;;) {
        const highest = listRequestIds(childId).map(requestNumber).at(-1) ?? 0;
        const request = { childId, requestId: `r${highest + 1}` };
        try {
          fs.mkdirSync(requestDir(request), { mode: DIR_MODE });
        } catch (error) {
          if (isTaken(error)) continue;
          throw error;
        }
        const record: RequestRecord = {
          version: 1,
          request,
          instruction,
          submittedAt: new Date().toISOString(),
        };
        writeJson(path.join(requestDir(request), "request.json"), record);
        return record;
      }
    },

    readRequest: (ref) =>
      readJson<RequestRecord>(path.join(requestDir(ref), "request.json"), checkRequest(ref)),

    listRequestIds,

    readResult: (ref) =>
      readJson<ResultRecord>(path.join(requestDir(ref), "result.json"), checkResult(ref)),

    writeResult(record) {
      writeJson(path.join(requestDir(record.request), "result.json"), record);
    },

    readStatus: (childId) =>
      readJson<StatusRecord>(path.join(childDir(childId), "status.json"), checkStatus),

    writeStatus(childId, record) {
      writeJson(path.join(childDir(childId), "status.json"), record);
    },

    listChildIds: () => readDir(childrenDir).filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name)),

    createReport(report) {
      fs.mkdirSync(path.join(childDir(report.childId), "reports"), {
        recursive: true,
        mode: DIR_MODE,
      });
      for (;;) {
        const highest = listReportIds(report.childId).map(reportNumber).at(-1) ?? 0;
        const record: ReportRecord = {
          version: 1,
          ...report,
          reportId: `m${highest + 1}`,
          createdAt: new Date().toISOString(),
        };
        if (writeJsonOnce(reportFile(record.childId, record.reportId), record)) return record;
      }
    },

    listReportIds,

    readReport: (childId, reportId) =>
      readJson<ReportRecord>(reportFile(childId, reportId), checkReport(childId, reportId)),

    writeTmuxConf(content) {
      fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
      const file = path.join(root, "tmux.conf");
      writeAtomic(file, content);
      return file;
    },
  };
}
