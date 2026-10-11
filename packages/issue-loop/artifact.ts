import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, git } from "./process.ts";

/**
 * Git artifact/history helpers: content identities, branch/HEAD/index/worktree
 * guards, controller-owned feature/fixup commits, hook classification, and
 * verifiable pending-operation reconciliation. Transport and state persistence
 * stay with their owning modules.
 */

/** Exact reviewed artifact. `tree` includes relevant untracked files. */
export interface ArtifactIdentity {
  head: string;
  tree: string;
}

/** Full read-only guard surface, not just HEAD. */
export interface ArtifactSnapshot {
  branch: string;
  head: string;
  /** Tree of the real index as staged. */
  index: string;
  /** Content tree of the working tree including relevant untracked files. */
  worktree: string;
}

/**
 * Tree of the working tree including relevant untracked files, computed with a
 * throwaway index so the real index is never staged by a read-only guard.
 */
export async function contentTree(cwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "issue-loop-content-"));
  const index = join(dir, "index");
  try {
    const env = { GIT_INDEX_FILE: index };
    await command("git", ["read-tree", "HEAD"], { cwd, env });
    await command("git", ["add", "-A"], { cwd, env });
    return await command("git", ["write-tree"], { cwd, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function artifactSnapshot(cwd: string): Promise<ArtifactSnapshot> {
  const [branch, head, index, worktree] = await Promise.all([
    git(cwd, "branch", "--show-current"),
    git(cwd, "rev-parse", "HEAD"),
    git(cwd, "write-tree"),
    contentTree(cwd),
  ]);
  return { branch, head, index, worktree };
}

/** The identity a review verdict is tied to. */
export function identityOf(snapshot: ArtifactSnapshot): ArtifactIdentity {
  return { head: snapshot.head, tree: snapshot.worktree };
}

/** Throw if any guarded part of the artifact changed under a read-only step. */
export function assertArtifactUnchanged(
  before: ArtifactSnapshot,
  after: ArtifactSnapshot,
  action: string,
): void {
  for (const key of ["branch", "head", "index", "worktree"] as const) {
    if (before[key] !== after[key])
      throw new Error(
        `${action} changed the ${key}. Work is preserved; inspect the worktree and resume`,
      );
  }
}

export interface WorkCommit {
  sha: string;
  /** A successful clean hook changed the committed tree; the caller must recheck it. */
  mutated: boolean;
  /** A successful hook left uncommitted changes; the caller must stop, not reconcile. */
  dirty: boolean;
}

/**
 * Controller-persisted intent for one Git commit, recorded before Git runs so a
 * crash between Git and state persistence can be reconciled on resume.
 */
export interface CommitIntent {
  /** Stable operation identity for this controller step. */
  operation: string;
  /** Stable run identity embedded as a commit trailer. */
  run: string;
  /** Stable step identity embedded as a commit trailer. */
  step: string;
  /** Readable feature subject, or the anchor a standard fixup targets. */
  subject: string;
  /** Anchor commit a fixup targets; absent when this creates the anchor. */
  fixup?: string;
  /** HEAD the new commit must descend from. */
  parent: string;
  /** Content tree the new commit is expected to contain. */
  expectedTree: string;
  /** Ticket number this controller commit belongs to. */
  ticket?: number;
}

/**
 * A rejected commit hook. `configuration` distinguishes a proven actionable
 * code/test/lint failure (repairable) from signing/identity/tooling or any
 * unclassified failure (stop for operator recovery). Hooks are never bypassed.
 */
export class HookFailure extends Error {
  readonly configuration: boolean;
  constructor(message: string, configuration: boolean) {
    super(message);
    this.name = "HookFailure";
    this.configuration = configuration;
  }
}

/**
 * Signing, identity, and missing-tool diagnostics take precedence over code
 * diagnostics, including when hooks emit both. `fatal:` covers Git diagnostics broadly
 * (for example SSH signing without `user.signingkey`), so an unrecognized fatal
 * stops for recovery instead of being mistaken for a code defect.
 */
const CONFIGURATION_FAILURES = [
  /gpg failed to sign/i,
  /failed to write commit object/i,
  /cannot (?:exec|run)\b/i,
  /\bcommand not found\b/i,
  /:[^\S\r\n]*not found\b/i,
  /(?:^|\n)[^\r\n]*\b(?:sh|bash|zsh|env):[^\r\n]*\b(?:not found|No such file or directory)\b/i,
  /\blinker[^\r\n]*\bnot found\b/i,
  /please tell me who you are/i,
  /author identity unknown/i,
  /empty ident name/i,
  /unable to auto-detect email address/i,
  /user\.signingkey or gpg\.ssh\.defaultKeyCommand/i,
  /(^|\n)fatal:/i,
];

export function isConfigurationFailure(message: string): boolean {
  return CONFIGURATION_FAILURES.some((pattern) => pattern.test(message));
}

/**
 * Positive evidence that a hook failed on a code/test/lint defect. Compiler,
 * test-runner, and linter diagnostics match; a missing executable, an
 * environment error, or any other output does not. Unknown diagnostics must
 * stop for operator recovery rather than spend a code-repair round the
 * controller cannot substantiate, so only recognized evidence is actionable.
 */
const ACTIONABLE_HOOK_FAILURES = [
  /\berror\s+TS\d+/i, // tsc: "error TS2322"
  /\bTS\d+:\s/, // tsc: "TS2322: message"
  /:\d+:\d+[:\s-]+(?:error|warning)\b/i, // "file:line:col: error"
  /:\d+:\d+\s+(?:lint\/|parse\b)/, // biome source diagnostic
  /\(\d+,\d+\)\s*:\s*(?:error|warning)\b/i, // tsc: "file(line,col): error"
  /^\s*error\[E\d+\]:\s/m, // rustc: "error[E0499]:"
  /\bAssertionError\b/,
  /\b(?:Tests?|Test Files?)\b.*\b\d+\s+failed\b/i,
  /Code style issues found/i, // prettier --check
  /Formatter would have printed the following content/, // biome format
];

export function isActionableHookFailure(message: string): boolean {
  if (isConfigurationFailure(message)) return false;
  return message
    .split("\n")
    .some((line) => ACTIONABLE_HOOK_FAILURES.some((pattern) => pattern.test(line)));
}

/**
 * Create a controller-owned work commit. The first changed phase of an artifact
 * is its feature anchor; later changed phases are standard `fixup!` commits
 * targeting that anchor. Hooks run normally and are never bypassed.
 */
export async function commitWork(
  cwd: string,
  options: {
    subject: string;
    fixup?: string;
    expectedTree: string;
    trailers?: Record<string, string>;
    /** Controller-owned Git deadline, separate from worker supervision. */
    timeoutMs?: number;
    /** Bounded combined hook/commit log for the repairer and operator. */
    log?: string;
  },
): Promise<WorkCommit> {
  const args = options.fixup
    ? ["commit", "--fixup", options.fixup]
    : ["commit", "-m", options.subject];
  // Stable run/step trailers keep the commit attributable without changing the
  // readable feature/fixup subject.
  for (const [token, value] of Object.entries(options.trailers ?? {}))
    args.push("--trailer", `${token}: ${value}`);
  try {
    await command("git", args, { cwd, log: options.log, timeoutMs: options.timeoutMs });
  } catch (error) {
    if (error instanceof Error && error.name === "CommandStoppedError") throw error;
    const detail = error instanceof Error ? error.message : String(error);
    let diagnostic = detail;
    if (options.log) {
      try {
        // Error messages contain only output tails; early configuration evidence
        // must still take precedence over later compiler diagnostics.
        diagnostic = readFileSync(options.log, "utf8");
      } catch {
        // An unreadable log cannot substantiate a code defect. Preserve work
        // and stop rather than classify the incomplete error excerpt.
        diagnostic = "";
      }
    }
    throw new HookFailure(
      `Git hooks rejected the work commit; the work is preserved. ${detail}`,
      !isActionableHookFailure(diagnostic),
    );
  }
  const sha = await git(cwd, "rev-parse", "HEAD");
  const dirty = (await git(cwd, "status", "--porcelain")) !== "";
  const tree = await git(cwd, "rev-parse", "HEAD^{tree}");
  return { sha, mutated: tree !== options.expectedTree, dirty };
}

export type CommitReconciliation =
  | { kind: "completed"; sha: string }
  | { kind: "pending" }
  | { kind: "ambiguous"; detail: string };

/**
 * Reconcile a persisted commit intent after a crash. A provably completed
 * operation is recovered once; an unchanged parent means Git never committed;
 * anything else blocks. Identity requires the exact parent lineage, the
 * expected content tree, and the stable run/step trailers together, so neither
 * a trailer match nor HEAD movement alone can masquerade as the operation. A
 * commit whose tree was changed by a hook no longer matches and blocks with
 * preserved work rather than being accepted unverified.
 */
export async function reconcileCommitIntent(
  cwd: string,
  intent: CommitIntent,
): Promise<CommitReconciliation> {
  const head = await git(cwd, "rev-parse", "HEAD");
  if (head === intent.parent) return { kind: "pending" };
  const candidates = (await git(cwd, "rev-list", "--reverse", `${intent.parent}..HEAD`))
    .split("\n")
    .filter(Boolean);
  const matches: string[] = [];
  const expectedTrailers = [`Loop-Run: ${intent.run}`, `Loop-Step: ${intent.step}`];
  for (const sha of candidates) {
    const [firstParent = ""] = (await git(cwd, "rev-list", "--parents", "-n", "1", sha))
      .split(" ")
      .slice(1);
    const tree = await git(cwd, "rev-parse", `${sha}^{tree}`);
    const body = await git(cwd, "log", "-1", "--format=%B", sha);
    if (
      firstParent === intent.parent &&
      tree === intent.expectedTree &&
      expectedTrailers.every((trailer) => body.includes(trailer))
    )
      matches.push(sha);
  }
  if (matches.length === 1) return { kind: "completed", sha: matches[0] };
  return {
    kind: "ambiguous",
    detail: matches.length
      ? `${matches.length} commits match operation ${intent.operation}`
      : `no commit since parent ${intent.parent} matches operation ${intent.operation} and tree ${intent.expectedTree}`,
  };
}
