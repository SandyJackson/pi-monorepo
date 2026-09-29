import { spawn } from "node:child_process";

/** Result of one `wt` invocation. A null exit code means the binary never ran. */
export interface WtResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Boundary between the Worktrunk extension and the `wt` CLI. Implementations
 * receive argv and a working directory; tests inject scripted results.
 */
export type WtExecutor = (args: readonly string[], cwd: string) => Promise<WtResult>;

/** Run `wt` with argv execution only, never through a shell. */
export function createWtExecutor(): WtExecutor {
  return (args, cwd) =>
    new Promise((resolve) => {
      const child = spawn("wt", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: WtResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (data: string) => {
        stdout += data;
      });
      child.stderr?.on("data", (data: string) => {
        stderr += data;
      });
      child.on("error", (error) => {
        finish({ exitCode: null, stdout, stderr: stderr || error.message });
      });
      child.on("close", (code) => {
        finish({ exitCode: code, stdout, stderr });
      });
    });
}

export interface WorktreeDiff {
  added: number;
  deleted: number;
}

export interface WorktreeChanges {
  staged: boolean;
  modified: boolean;
  untracked: boolean;
  renamed: boolean;
  deleted: boolean;
  conflicted: boolean;
  diff: WorktreeDiff | null;
}

/** One Worktrunk worktree row, taken from `wt list --format=json` schema 2. */
export interface Worktree {
  branch: string | null;
  path: string;
  main: boolean;
  current: boolean;
  previous: boolean;
  detached: boolean;
  changes: WorktreeChanges | null;
  marker: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): Error {
  return new Error(`unexpected wt list output: ${detail}`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalid(`${field} is not a string`);
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return readString(value, field);
}

function readBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw invalid(`${field} is not a boolean`);
  return value;
}

function readCount(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${field} is not a number`);
  }
  return value;
}

function parseDiff(value: unknown): WorktreeDiff | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw invalid("worktree.changes.diff is not an object");
  return {
    added: readCount(value.added, "worktree.changes.diff.added"),
    deleted: readCount(value.deleted, "worktree.changes.diff.deleted"),
  };
}

function parseChanges(value: unknown): WorktreeChanges | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw invalid("worktree.changes is not an object");
  return {
    staged: readBoolean(value.staged, "worktree.changes.staged"),
    modified: readBoolean(value.modified, "worktree.changes.modified"),
    untracked: readBoolean(value.untracked, "worktree.changes.untracked"),
    renamed: readBoolean(value.renamed, "worktree.changes.renamed"),
    deleted: readBoolean(value.deleted, "worktree.changes.deleted"),
    conflicted: readBoolean(value.conflicted, "worktree.changes.conflicted"),
    diff: parseDiff(value.diff),
  };
}

function parseWorktree(item: Record<string, unknown>, worktree: Record<string, unknown>): Worktree {
  return {
    branch: readNullableString(item.branch, "branch"),
    path: readString(worktree.path, "worktree.path"),
    main: readBoolean(worktree.main, "worktree.main"),
    current: readBoolean(worktree.current, "worktree.current"),
    previous: readBoolean(worktree.previous, "worktree.previous"),
    detached: readBoolean(worktree.detached, "worktree.detached"),
    changes: parseChanges(worktree.changes),
    marker: readNullableString(item.marker, "marker"),
  };
}

/** Parse the schema-2 envelope emitted by `wt list --format=json`. */
export function parseWorktreeList(stdout: string): Worktree[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw invalid("not JSON");
  }
  if (!isRecord(envelope)) throw invalid("the top level is not a schema-2 envelope");
  if (envelope.schema !== 2) {
    throw invalid(`expected schema 2, received ${JSON.stringify(envelope.schema)}`);
  }
  if (!Array.isArray(envelope.items)) throw invalid("items is not an array");

  const worktrees: Worktree[] = [];
  for (const item of envelope.items) {
    if (!isRecord(item)) throw invalid("an item is not an object");
    if (item.worktree === undefined || item.worktree === null) continue;
    if (!isRecord(item.worktree)) throw invalid("worktree is not an object");
    worktrees.push(parseWorktree(item, item.worktree));
  }
  return worktrees;
}

function formatChanges(changes: WorktreeChanges): string {
  let markers = "";
  if (changes.staged) markers += "+";
  if (changes.modified) markers += "!";
  if (changes.untracked) markers += "?";
  if (changes.renamed) markers += "r";
  if (changes.deleted) markers += "d";
  if (changes.conflicted) markers += "✘";

  const diff = changes.diff;
  if (diff && (diff.added > 0 || diff.deleted > 0)) {
    markers += `${markers ? " " : ""}+${diff.added} -${diff.deleted}`;
  }
  return markers;
}

/** Plain-text summary of worktree state for the `/wt` notification. */
export function formatWorktreeList(worktrees: Worktree[]): string {
  if (worktrees.length === 0) return "Worktrunk reported no worktrees.";

  const lines = worktrees.map((worktree) => {
    const flags: string[] = [];
    if (worktree.current) flags.push("current");
    if (worktree.previous) flags.push("previous");
    if (worktree.main) flags.push("main");
    if (worktree.detached) flags.push("detached");

    const branch = worktree.branch ?? "(detached)";
    const marker = worktree.marker ? ` ${worktree.marker}` : "";
    const changes = worktree.changes ? formatChanges(worktree.changes) : "";
    const parts = [`${branch}${marker}`, flags.length > 0 ? `[${flags.join(", ")}]` : "", changes];
    return `  ${parts.filter(Boolean).join("  ")}`;
  });

  return [`Worktrunk worktrees (${worktrees.length}):`, ...lines].join("\n");
}

export interface WorktrunkUi {
  cwd: string;
  notify(message: string, type: "info" | "warning" | "error"): void;
}

function failureDetail(result: WtResult): string {
  const parts = [result.stderr.trim(), result.stdout.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : "no output";
}

/** Run `wt list` and report either the worktree inventory or the CLI failure. */
export async function runWorktreeList(executor: WtExecutor, ui: WorktrunkUi): Promise<void> {
  let result: WtResult;
  try {
    result = await executor(["list", "--format=json"], ui.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.notify(`wt list failed: ${message}`, "error");
    return;
  }

  if (result.exitCode !== 0) {
    ui.notify(`wt list failed:\n${failureDetail(result)}`, "error");
    return;
  }

  try {
    ui.notify(formatWorktreeList(parseWorktreeList(result.stdout)), "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.notify(`wt list failed: ${message}\n${failureDetail(result)}`, "error");
  }
}
