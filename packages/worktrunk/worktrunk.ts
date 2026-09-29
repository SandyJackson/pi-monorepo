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

export type WorktrunkNotifyType = "info" | "warning" | "error";

/** UI surface `/wt` needs; `index.ts` supplies the SelectList, tests inject a fake. */
export interface WorktrunkUi {
  cwd: string;
  notify(message: string, type: WorktrunkNotifyType): void;
  selectWorktree(worktrees: readonly Worktree[]): Promise<Worktree | null>;
}

export type PickerColor = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text";

/** Subset of Pi's theme the picker rows need. */
export interface PickerTheme {
  fg(color: PickerColor, text: string): string;
}

/** One `SelectList` row. `value` is the worktree path. */
export interface WorktreeRow {
  value: string;
  label: string;
  description: string;
}

function branchName(worktree: Worktree): string {
  return worktree.branch ?? "(detached)";
}

function changeMarkers(changes: WorktreeChanges | null, theme: PickerTheme): string {
  if (!changes) return "";
  let markers = "";
  if (changes.staged) markers += theme.fg("success", "+");
  if (changes.modified) markers += theme.fg("warning", "!");
  if (changes.untracked) markers += theme.fg("muted", "?");
  if (changes.renamed) markers += theme.fg("accent", "r");
  if (changes.deleted) markers += theme.fg("error", "d");
  if (changes.conflicted) markers += theme.fg("error", "✘");
  return markers;
}

function diffCounts(diff: WorktreeDiff | null, theme: PickerTheme): string {
  if (!diff) return "";
  const counts: string[] = [];
  if (diff.added > 0) counts.push(theme.fg("success", `+${diff.added}`));
  if (diff.deleted > 0) counts.push(theme.fg("error", `-${diff.deleted}`));
  return counts.join(" ");
}

/** Build picker rows from Worktrunk JSON, re-rendering state in Pi theme colors. */
export function buildWorktreeRows(
  worktrees: readonly Worktree[],
  theme: PickerTheme,
): WorktreeRow[] {
  return worktrees.map((worktree) => {
    const branch = branchName(worktree);
    const branchText = worktree.detached
      ? theme.fg("dim", branch)
      : worktree.current
        ? theme.fg("accent", branch)
        : theme.fg("text", branch);
    const label = worktree.marker
      ? `${branchText} ${theme.fg("accent", worktree.marker)}`
      : branchText;

    const flags: string[] = [];
    if (worktree.current) flags.push(theme.fg("success", "current"));
    if (worktree.previous) flags.push(theme.fg("warning", "previous"));
    if (worktree.main) flags.push(theme.fg("muted", "main"));

    const description = [
      ...flags,
      changeMarkers(worktree.changes, theme),
      diffCounts(worktree.changes?.diff ?? null, theme),
    ]
      .filter(Boolean)
      .join(" ");

    return { value: worktree.path, label, description };
  });
}

function failureDetail(result: WtResult): string {
  const parts = [result.stderr.trim(), result.stdout.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : "no output";
}

/** `/wt`: list worktrees, let the user pick one, and report the choice. */
export async function runWorktreePicker(executor: WtExecutor, ui: WorktrunkUi): Promise<void> {
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

  let worktrees: Worktree[];
  try {
    worktrees = parseWorktreeList(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.notify(`wt list failed: ${message}\n${failureDetail(result)}`, "error");
    return;
  }

  if (worktrees.length === 0) {
    ui.notify("Worktrunk reported no worktrees.", "info");
    return;
  }

  const choice = await ui.selectWorktree(worktrees);
  if (!choice) {
    return;
  }

  const branch = branchName(choice);
  if (choice.current) {
    ui.notify(`Already in ${branch}.`, "info");
    return;
  }

  ui.notify(`Selected ${branch}; switching is not implemented yet.`, "info");
}
