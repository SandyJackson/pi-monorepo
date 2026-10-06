import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, git } from "./process.ts";

/**
 * Git artifact/history helpers: content identities, branch/HEAD/index/worktree
 * guards, and controller-owned feature/fixup commits. Transport and state
 * persistence stay with their owning modules.
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
 * Create a controller-owned work commit. The first changed phase of an artifact
 * is its feature anchor; later changed phases are standard `fixup!` commits
 * targeting that anchor. Hooks run normally and are never bypassed.
 */
export async function commitWork(
  cwd: string,
  options: { subject: string; fixup?: string; expectedTree: string },
): Promise<WorkCommit> {
  const args = options.fixup
    ? ["commit", "--fixup", options.fixup]
    : ["commit", "-m", options.subject];
  try {
    await command("git", args, { cwd });
  } catch (error) {
    throw new Error(
      `Git hooks rejected the work commit; the work is preserved. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sha = await git(cwd, "rev-parse", "HEAD");
  const dirty = (await git(cwd, "status", "--porcelain")) !== "";
  const tree = await git(cwd, "rev-parse", "HEAD^{tree}");
  return { sha, mutated: tree !== options.expectedTree, dirty };
}
