import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type {
  CustomEntry,
  EntryRenderOptions,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";

/** The active-session surface the relocation path reads. */
export interface SessionSource {
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getBranch(fromId?: string): SessionEntry[];
}

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

/** Dirty flags come from a `changes` object that Worktrunk only emits when the
 * worktree state is known. An absent flag means the output is not the schema-2
 * shape, so it must fail parsing rather than defaulting to clean. */
function readFlag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${field} is not a boolean`);
  return value;
}

/** `conflicted` is the one change flag Worktrunk documents as boolean/null:
 * null means the conflict check was skipped, not that conflicts are impossible. */
function readConflictFlag(value: unknown, field: string): boolean {
  return value === null ? false : readFlag(value, field);
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
    staged: readFlag(value.staged, "worktree.changes.staged"),
    modified: readFlag(value.modified, "worktree.changes.modified"),
    untracked: readFlag(value.untracked, "worktree.changes.untracked"),
    renamed: readFlag(value.renamed, "worktree.changes.renamed"),
    deleted: readFlag(value.deleted, "worktree.changes.deleted"),
    conflicted: readConflictFlag(value.conflicted, "worktree.changes.conflicted"),
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

function invalidSwitch(detail: string): Error {
  return new Error(`unexpected wt switch output: ${detail}`);
}

/** Read the target path from the object emitted by `wt switch --format=json`. */
export function parseWorktreeSwitch(stdout: string): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw invalidSwitch("not JSON");
  }
  if (!isRecord(envelope)) throw invalidSwitch("not an object");
  if (typeof envelope.path !== "string" || envelope.path.length === 0) {
    throw invalidSwitch("path is missing");
  }
  return envelope.path;
}

export type WorktrunkNotifyType = "info" | "warning" | "error";

/** What to do about an agent that is still streaming when `/wt` is invoked. */
export type BusyAction = "wait" | "abort";

/** A picker outcome: switch to an existing worktree, or create a new branch. */
export type PickerChoice =
  | { kind: "worktree"; worktree: Worktree }
  | { kind: "create"; branch: string };

/** UI surface `/wt` needs; `index.ts` supplies the components, tests inject a fake. */
export interface WorktrunkUi {
  cwd: string;
  notify(message: string, type: WorktrunkNotifyType): void;
  selectWorktree(worktrees: readonly Worktree[]): Promise<PickerChoice | null>;
  /** Run one step under a loader that offers no cancel affordance. */
  withLoader<T>(label: string, run: () => Promise<T>): Promise<T>;
  /** Ask what to do about a running agent; null when the dialog is dismissed. */
  chooseBusyAction(): Promise<BusyAction | null>;
  /** Confirm switching away from a worktree with uncommitted changes. */
  confirmDirty(branch: string): Promise<boolean>;
}

/** Session-bound surface available only after the runtime has been replaced. */
export interface RelocatedSession {
  notify(message: string, type: WorktrunkNotifyType): void;
}

/** Durable record persisted into the target session before the switch. It is
 * rendered by the entry renderer, never enters the LLM context, and is the
 * recovery key for re-queueing the LLM-facing note on later session starts. */
export interface RelocationRecord {
  branch: string;
  sourcePath: string;
  targetPath: string;
  note: string;
}

/** A relocation record whose LLM-facing note still has to reach the model. */
export interface RelocationDelivery {
  /** Entry id of the relocation record; keys the persisted delivery marker. */
  relocationId: string;
  note: string;
}

/** Session-relocation boundary. `prepare` carries the active conversation into
 * the target worktree, appends the relocation record, and returns the persisted
 * session file; `switch` replaces the runtime. Tests inject a fake.
 * `waitForIdle` must run before `prepare` so a mid-turn agent cannot write
 * entries past the captured leaf. */
export interface SwitchExecutor {
  /** Whether the agent is still streaming. */
  isBusy(): boolean;
  /** Abort the running agent; the caller waits for idle afterwards. */
  abort(): void;
  waitForIdle(): Promise<void>;
  prepare(targetPath: string, record: RelocationRecord): string;
  switch(
    sessionFile: string,
    withSession: (session: RelocatedSession) => Promise<void>,
  ): Promise<{ cancelled: boolean }>;
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

/** True when Worktrunk reports uncommitted changes in a worktree. */
function hasUncommittedChanges(changes: WorktreeChanges | null): boolean {
  if (!changes) return false;
  return (
    changes.staged ||
    changes.modified ||
    changes.untracked ||
    changes.renamed ||
    changes.deleted ||
    changes.conflicted
  );
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

/** Directory holding one recovery state file per session under the agent dir. */
const RECOVERY_STATE_DIR = "worktrunk-recovery";

/** Path of the state file recording one session's main checkout. Recovery is
 * one file per session: a shared file needs a coordinated read-modify-write,
 * and a concurrent session start could drop another session's entry, stranding
 * it when its worktree is deleted. The id is encoded because a session loaded
 * from a crafted file can carry path separators. */
function recoveryStatePath(stateDir: string, sessionId: string): string {
  return join(stateDir, RECOVERY_STATE_DIR, `${encodeURIComponent(sessionId)}.json`);
}

/**
 * Read the recovery worktree recorded for one session, or null when the state
 * is missing, malformed, or has no worktree. A missing recovery never blocks
 * startup.
 */
export function readRecoveryWorktree(stateDir: string, sessionId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recoveryStatePath(stateDir, sessionId), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.worktree !== "string" || parsed.worktree.length === 0) {
    return null;
  }
  return parsed.worktree;
}

/** Persist one session's main checkout so its deleted worktree can be recovered
 * from. Each session owns its file, so concurrent session starts cannot discard
 * each other's entry; the unique temporary and rename keep readers from seeing
 * a partial write. */
export function writeRecoveryWorktree(stateDir: string, sessionId: string, worktree: string): void {
  const file = recoveryStatePath(stateDir, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ worktree }), { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * Record the repository's main checkout for recovery. Best effort: a missing
 * `wt`, a non-repository cwd, or malformed output leaves the saved state alone
 * and never interrupts session startup.
 */
export async function recordRecoveryWorktree(
  executor: WtExecutor,
  stateDir: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const listed = await listWorktrees(executor, cwd);
  if (!listed.ok) return;
  const main = listed.worktrees.find((worktree) => worktree.main);
  if (!main) return;
  try {
    writeRecoveryWorktree(stateDir, sessionId, main.path);
  } catch {
    // Recovery is convenience state; a write failure must not break startup.
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carry the active conversation into `targetCwd` as a persisted session.
 *
 * The source file is forked when its persisted leaf still matches the active
 * leaf. A drifted leaf means the file no longer reflects the active branch, so
 * the active branch entries are written into a fresh target session instead.
 * Empty or ephemeral conversations get a fresh session. The prepared session
 * is always reopened and verified before it is returned.
 */
export function prepareTargetSession(
  source: SessionSource,
  targetCwd: string,
  record: RelocationRecord,
  sessionDir?: string,
): string {
  const activeLeaf = source.getLeafId();
  const sourceFile = source.getSessionFile();

  if (!sourceFile || activeLeaf === null) {
    return createFreshTargetSession(targetCwd, sessionDir, sourceFile ?? null, record);
  }

  const persistedLeaf = SessionManager.open(sourceFile).getLeafId();
  if (persistedLeaf !== null && persistedLeaf === activeLeaf) {
    const forked = SessionManager.forkFrom(sourceFile, targetCwd, sessionDir);
    const file = forked.getSessionFile();
    if (!file) throw new Error("could not persist the target session");
    return appendRelocationRecord(file, record, activeLeaf);
  }

  return copyActiveBranch(source, sourceFile, activeLeaf, targetCwd, sessionDir, record);
}

function targetHeader(manager: SessionManager, parentSession: string | null): string {
  const header = manager.getHeader();
  if (!header) throw new Error("could not build the target session header");
  return JSON.stringify({ ...header, parentSession: parentSession ?? undefined });
}

function createFreshTargetSession(
  targetCwd: string,
  sessionDir: string | undefined,
  parentSession: string | null,
  record: RelocationRecord,
): string {
  const manager = SessionManager.create(targetCwd, sessionDir);
  const file = manager.getSessionFile();
  if (!file) throw new Error("could not persist the target session");
  writeFileSync(file, `${targetHeader(manager, parentSession)}\n`, { flag: "wx" });
  return appendRelocationRecord(file, record, null);
}

function copyActiveBranch(
  source: SessionSource,
  sourceFile: string,
  activeLeaf: string,
  targetCwd: string,
  sessionDir: string | undefined,
  record: RelocationRecord,
): string {
  const entries = source.getBranch(activeLeaf);
  if (entries.length === 0) {
    throw new Error(`active session branch ${activeLeaf} has no entries`);
  }
  const manager = SessionManager.create(targetCwd, sessionDir);
  const file = manager.getSessionFile();
  if (!file) throw new Error("could not persist the target session");
  const lines = [targetHeader(manager, sourceFile)];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(file, `${lines.join("\n")}\n`, { flag: "wx" });
  return appendRelocationRecord(file, record, activeLeaf);
}

/** Append the relocation record on top of the carried branch, then verify the
 * reopened file: the record must be the new leaf, its parent must still be the
 * carried leaf, and the cwd must match the target worktree. */
function appendRelocationRecord(
  file: string,
  record: RelocationRecord,
  priorLeaf: string | null,
): string {
  const manager = SessionManager.open(file);
  if (manager.getLeafId() !== priorLeaf) {
    throw new Error(`prepared session leaf ${manager.getLeafId()} does not match ${priorLeaf}`);
  }
  const recordId = manager.appendCustomEntry(RELOCATION_CUSTOM_TYPE, record);
  verifyTargetSession(file, record, recordId, priorLeaf);
  return file;
}

function verifyTargetSession(
  file: string,
  record: RelocationRecord,
  recordId: string,
  priorLeaf: string | null,
): void {
  const reopened = SessionManager.open(file);
  const expectedCwd = resolvePath(record.targetPath);
  if (reopened.getCwd() !== expectedCwd) {
    throw new Error(`prepared session cwd ${reopened.getCwd()} does not match ${expectedCwd}`);
  }
  if (reopened.getLeafId() !== recordId) {
    throw new Error(
      `prepared session leaf ${reopened.getLeafId()} does not match the relocation record ${recordId}`,
    );
  }
  const entry = reopened.getEntry(recordId);
  if (entry?.type !== "custom" || entry.customType !== RELOCATION_CUSTOM_TYPE) {
    throw new Error(`prepared session is missing the relocation record ${recordId}`);
  }
  if (entry.parentId !== priorLeaf) {
    throw new Error(
      `relocation record parent ${entry.parentId} does not match the carried leaf ${priorLeaf}`,
    );
  }
  if (!isRelocationRecord(entry.data) || JSON.stringify(entry.data) !== JSON.stringify(record)) {
    throw new Error(`relocation record ${recordId} did not survive persistence`);
  }
}

export const RELOCATION_CUSTOM_TYPE = "worktrunk-relocation";

export function isRelocationRecord(value: unknown): value is RelocationRecord {
  return (
    isRecord(value) &&
    typeof value.branch === "string" &&
    typeof value.sourcePath === "string" &&
    typeof value.targetPath === "string" &&
    typeof value.note === "string"
  );
}

function isRelocationRecordEntry(
  entry: SessionEntry,
): entry is CustomEntry<RelocationRecord> & { data: RelocationRecord } {
  return (
    entry.type === "custom" &&
    entry.customType === RELOCATION_CUSTOM_TYPE &&
    isRelocationRecord(entry.data)
  );
}

/** Pick the relocation note that still has to reach the model on this branch.
 * Only the latest record counts: it supersedes prior undelivered records even
 * when it is already delivered. A record whose target cwd no longer matches the
 * active cwd is never used, and an older record is never fallen back to. */
export function findUndeliveredRelocation(
  branch: readonly SessionEntry[],
  cwd: string,
): RelocationDelivery | null {
  const records = branch.filter(isRelocationRecordEntry);
  const latest = records[records.length - 1];
  if (!latest) return null;

  const record = latest.data;
  if (resolvePath(record.targetPath) !== resolvePath(cwd)) return null;

  const delivered = branch.some(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === RELOCATION_CUSTOM_TYPE &&
      isRecord(entry.details) &&
      entry.details.relocationId === latest.id,
  );
  if (delivered) return null;

  return { relocationId: latest.id, note: record.note };
}

/** Render the persisted relocation record in the transcript. The record never
 * enters the LLM context; this is the durable, visible relocation notice. */
export function renderRelocationEntry(
  entry: CustomEntry<RelocationRecord>,
  options: EntryRenderOptions,
  theme: PickerTheme,
): Component | undefined {
  // The entry comes from persisted JSONL, so the data still needs validation.
  if (!isRelocationRecord(entry.data)) return undefined;
  const record = entry.data;
  const container = new Container();
  container.addChild(new Text(`${theme.fg("accent", "[worktrunk]")} ${record.note}`, 0, 0));
  if (options.expanded) {
    container.addChild(
      new Text(
        theme.fg("dim", `branch ${record.branch} · ${record.sourcePath} → ${record.targetPath}`),
        0,
        0,
      ),
    );
  }
  return container;
}

function relocationNote(branch: string, sourcePath: string, targetPath: string): string {
  return [
    `Worktree relocation: this session moved from ${sourcePath} to ${targetPath} (branch ${branch}).`,
    `Your working directory is now ${targetPath}.`,
    "Absolute paths from earlier in this conversation belong to the previous checkout: do not reuse them and do not cd back.",
  ].join(" ");
}

function canonicalWorktreePath(reported: string): string {
  const resolved = realpathSync(reported);
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`${reported} is not a directory`);
  }
  return resolved;
}

/** Where `/wt` runs Worktrunk for one session: the live session cwd, or the
 * recorded main checkout when the session cwd has been deleted elsewhere. */
interface WtContext {
  cwd: string;
  recovery: boolean;
}

/** Filesystem facts the picker needs to choose where Worktrunk runs. The
 * caller supplies them from the real session cwd; the picker itself is
 * filesystem-free apart from validating the recovery worktree. */
export interface WtSwitchContext {
  /** Whether the session cwd still exists on disk. */
  cwdExists: boolean;
  /** Main checkout recorded at session start, used when the cwd is gone. */
  recoveryWorktree: string | null;
}

const LIVE_SWITCH_CONTEXT: WtSwitchContext = { cwdExists: true, recoveryWorktree: null };

/** Resolve the directory Worktrunk runs from; null when neither the session cwd
 * nor a usable recovery worktree exists. */
function resolveWtContext(cwd: string, context: WtSwitchContext): WtContext | null {
  if (context.cwdExists) return { cwd, recovery: false };
  if (context.recoveryWorktree && existsSync(context.recoveryWorktree)) {
    return { cwd: context.recoveryWorktree, recovery: true };
  }
  return null;
}

/** Bind the executor to the resolved context. Recovery runs every command from
 * the recovery worktree with `-C`, because the session cwd is gone. */
function bindWtContext(executor: WtExecutor, context: WtContext): WtExecutor {
  return (args) =>
    executor(context.recovery ? ["-C", context.cwd, ...args] : [...args], context.cwd);
}

/** `/wt`: list worktrees, let the user pick one, and relocate into it. */
export async function runWorktreePicker(
  executor: WtExecutor,
  switchExecutor: SwitchExecutor,
  ui: WorktrunkUi,
  switchContext: WtSwitchContext = LIVE_SWITCH_CONTEXT,
): Promise<void> {
  const context = resolveWtContext(ui.cwd, switchContext);
  if (!context) {
    const recoveryDetail = switchContext.recoveryWorktree
      ? `the recorded recovery worktree ${switchContext.recoveryWorktree} is gone`
      : "no recovery worktree is recorded";
    ui.notify(
      `Cannot switch: the session worktree ${ui.cwd} no longer exists and ${recoveryDetail}.`,
      "error",
    );
    return;
  }
  const wt = bindWtContext(executor, context);

  const listed = await listWorktrees(wt, context.cwd);
  if (!listed.ok) {
    ui.notify(listed.message, "error");
    return;
  }
  const worktrees = listed.worktrees;

  if (worktrees.length === 0) {
    ui.notify("Worktrunk reported no worktrees.", "info");
    return;
  }

  const choice = await ui.selectWorktree(worktrees);
  if (!choice) {
    return;
  }

  // Worktrunk marks the recovery worktree current because it ran with `-C`;
  // the session is not actually there, so selecting it must still relocate.
  if (!context.recovery && choice.kind === "worktree" && choice.worktree.current) {
    ui.notify(`Already in ${branchName(choice.worktree)}.`, "info");
    return;
  }

  if (!(await confirmSwitchGates(wt, switchExecutor, ui, context))) {
    return;
  }

  const request = switchRequest(choice);
  await relocateToWorktree(wt, switchExecutor, ui, request.branch, request.args);
}

/** The branch to report and the argv `wt switch` receives for one picker choice. */
function switchRequest(choice: PickerChoice): { branch: string; args: string[] } {
  if (choice.kind === "create") {
    return {
      branch: choice.branch,
      args: ["--create", choice.branch, "--no-cd", "--format=json"],
    };
  }
  return {
    branch: branchName(choice.worktree),
    args: [choice.worktree.branch ?? choice.worktree.path, "--no-cd", "--format=json"],
  };
}

type ListWorktreesResult = { ok: true; worktrees: Worktree[] } | { ok: false; message: string };

/** Run `wt list` and parse it, collecting the message the caller reports. */
async function listWorktrees(executor: WtExecutor, cwd: string): Promise<ListWorktreesResult> {
  let result: WtResult;
  try {
    result = await executor(["list", "--format=json"], cwd);
  } catch (error) {
    return { ok: false, message: `wt list failed: ${errorMessage(error)}` };
  }

  if (result.exitCode !== 0) {
    return { ok: false, message: `wt list failed:\n${failureDetail(result)}` };
  }

  try {
    return { ok: true, worktrees: parseWorktreeList(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      message: `wt list failed: ${errorMessage(error)}\n${failureDetail(result)}`,
    };
  }
}

/** Read dirty state after the run stops, including after an approved abort.
 * Declining confirmation prevents relocation but does not undo that abort. */
async function confirmSwitchGates(
  wt: WtExecutor,
  switchExecutor: SwitchExecutor,
  ui: WorktrunkUi,
  context: WtContext,
): Promise<boolean> {
  let busyAction: BusyAction | null = null;
  if (switchExecutor.isBusy()) {
    busyAction = await ui.chooseBusyAction();
    if (!busyAction) return false;
  }
  if (busyAction === "abort") switchExecutor.abort();
  await switchExecutor.waitForIdle();
  if (cancelIfBusy(switchExecutor, ui)) return false;

  // The session did not occupy the recovery anchor, so there is no source
  // worktree whose uncommitted changes could be left behind.
  if (!context.recovery) {
    const listed = await listWorktrees(wt, context.cwd);
    if (!listed.ok) {
      ui.notify(listed.message, "error");
      return false;
    }
    if (cancelIfBusy(switchExecutor, ui)) return false;
    const source = listed.worktrees.find((worktree) => worktree.current);
    if (!source) {
      ui.notify("Could not identify the source worktree. Switch cancelled.", "error");
      return false;
    }
    if (!source.changes) {
      ui.notify(
        "Could not determine the source worktree's dirty state. Switch cancelled.",
        "error",
      );
      return false;
    }
    if (hasUncommittedChanges(source.changes)) {
      if (!(await ui.confirmDirty(branchName(source)))) return false;
    }
  }

  if (cancelIfBusy(switchExecutor, ui)) return false;

  return true;
}

function cancelIfBusy(switchExecutor: SwitchExecutor, ui: WorktrunkUi): boolean {
  if (!switchExecutor.isBusy()) return false;
  ui.notify(
    "A new agent run started. Worktree relocation cancelled; run /wt again when it finishes.",
    "warning",
  );
  return true;
}

async function relocateToWorktree(
  executor: WtExecutor,
  switchExecutor: SwitchExecutor,
  ui: WorktrunkUi,
  branch: string,
  switchArgs: readonly string[],
): Promise<void> {
  if (cancelIfBusy(switchExecutor, ui)) return;

  let result: WtResult | null;
  try {
    result = await ui.withLoader(`Switching to ${branch}…`, async () => {
      if (cancelIfBusy(switchExecutor, ui)) return null;
      return executor(["switch", ...switchArgs], ui.cwd);
    });
  } catch (error) {
    ui.notify(`wt switch failed: ${errorMessage(error)}`, "error");
    return;
  }

  if (!result) return;
  if (result.exitCode !== 0) {
    ui.notify(`wt switch failed:\n${failureDetail(result)}`, "error");
    return;
  }

  let outcome: string;
  try {
    outcome = parseWorktreeSwitch(result.stdout);
  } catch (error) {
    ui.notify(`wt switch failed: ${errorMessage(error)}\n${failureDetail(result)}`, "error");
    return;
  }

  let targetPath: string;
  try {
    targetPath = canonicalWorktreePath(outcome);
  } catch (error) {
    ui.notify(`wt switch failed: ${errorMessage(error)}`, "error");
    return;
  }

  let preparedFile: string;
  const note = relocationNote(branch, ui.cwd, targetPath);
  try {
    if (cancelIfBusy(switchExecutor, ui)) return;
    await switchExecutor.waitForIdle();
    if (cancelIfBusy(switchExecutor, ui)) return;
    preparedFile = switchExecutor.prepare(targetPath, {
      branch,
      sourcePath: ui.cwd,
      targetPath,
      note,
    });
  } catch (error) {
    ui.notify(
      `Could not prepare the target session: ${errorMessage(error)}\n${failureDetail(result)}`,
      "error",
    );
    return;
  }

  try {
    await switchExecutor.switch(preparedFile, async (session) => {
      // The entry renderer shows the persisted record; the LLM-facing copy is
      // queued by the session_start handler on the new runtime.
      session.notify(`Moved to ${branch} at ${targetPath}.`, "info");
    });
  } catch (error) {
    ui.notify(`Could not complete the session switch: ${errorMessage(error)}`, "error");
  }
}
