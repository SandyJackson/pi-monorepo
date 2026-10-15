import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { ProjectTrustEventDecision, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

/** Entries under `<cwd>/.pi` that make Pi require project trust (mirrors Pi's trust-manager). */
const PI_CONFIG_RESOURCES = [
  "settings.json",
  "mcp.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
];

interface LinkedWorktree {
  root: string;
  mainWorktree: string;
  mainHead: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout;
}

/** Resolves cwd's linked worktree and its repository's main worktree, or undefined if cwd is not in a linked worktree. */
async function findLinkedWorktree(cwd: string): Promise<LinkedWorktree | undefined> {
  let revParse: string;
  try {
    revParse = await git(
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    );
  } catch {
    return undefined;
  }
  const [root, gitDir, commonDir] = revParse.trimEnd().split("\n");
  if (!root || gitDir === commonDir) return undefined;

  // The first `worktree list` entry is the main worktree: worktree, HEAD, then branch/detached/bare.
  const [mainEntry] = (await git(cwd, "worktree", "list", "--porcelain", "-z")).split("\0\0");
  const fields = mainEntry?.split("\0") ?? [];
  if (fields.includes("bare")) return undefined;
  const mainWorktree = fields.find((field) => field.startsWith("worktree "))?.slice(9);
  const mainHead = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
  if (!mainWorktree || !mainHead) return undefined;

  return { root: realpathSync(root), mainWorktree, mainHead };
}

/** Pi checks `.agents/skills` in cwd and every ancestor, ignoring the user's own `~/.agents/skills`. */
function hasProjectSkillsAbove(worktreeRoot: string): boolean {
  const userSkills = join(realpathSync(process.env.HOME || homedir()), ".agents", "skills");
  for (let dir = dirname(worktreeRoot); ; dir = dirname(dir)) {
    const skills = join(dir, ".agents", "skills");
    if (skills !== userSkills && existsSync(skills)) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** Paths, relative to the worktree root, of every resource Pi would load from cwd. */
function trustResourcePaths(worktreeRoot: string, cwd: string): string[] {
  const relativeCwd = relative(worktreeRoot, cwd);
  const paths = PI_CONFIG_RESOURCES.map((entry) => join(relativeCwd, ".pi", entry));
  for (let dir = relativeCwd; ; dir = dirname(dir)) {
    paths.push(join(dir, ".agents", "skills"));
    if (dir === "" || dir === ".") break;
  }
  return paths;
}

/**
 * True when a resource is reached through a symlink or contains a tracked one.
 * Pi follows symlinks, so the content it loads could lie outside the compared paths.
 */
async function resourcesUseSymlinks(
  worktreeRoot: string,
  paths: string[],
  pathspecs: string[],
): Promise<boolean> {
  for (const path of paths) {
    const absolute = join(worktreeRoot, path);
    if (existsSync(absolute) && realpathSync(absolute) !== absolute) return true;
  }
  const staged = await git(worktreeRoot, "ls-files", "--stage", "-z", "--", ...pathspecs);
  return staged.split("\0").some((entry) => entry.startsWith("120000 "));
}

/** True when the worktree's trust resources differ from the main worktree's HEAD, including uncommitted, untracked and ignored files. */
async function resourcesDiffer(
  worktreeRoot: string,
  mainHead: string,
  pathspecs: string[],
): Promise<boolean> {
  try {
    await git(worktreeRoot, "diff", "--quiet", mainHead, "--", ...pathspecs);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return true;
    throw error;
  }
  const untracked = await git(worktreeRoot, "ls-files", "--others", "-z", "--", ...pathspecs);
  return untracked !== "";
}

/**
 * Decides project trust for a linked Git worktree by inheriting its repository's trust.
 *
 * Returns "yes" only when the repository's main worktree is trusted and the
 * resources Pi would load from cwd match the main worktree's HEAD without
 * going through symlinks. Anything else is "undecided", so Pi falls back to saved decisions and its prompt.
 */
export async function decideWorktreeTrust(
  cwd: string,
  trustStore: Pick<ProjectTrustStore, "get">,
): Promise<ProjectTrustEventDecision> {
  // A saved decision for cwd or one of its ancestors stays authoritative.
  if (trustStore.get(cwd) !== null) return "undecided";

  const worktree = await findLinkedWorktree(cwd);
  if (!worktree) return "undecided";
  if (trustStore.get(worktree.mainWorktree) !== true) return "undecided";
  if (hasProjectSkillsAbove(worktree.root)) return "undecided";

  const paths = trustResourcePaths(worktree.root, realpathSync(cwd));
  const pathspecs = paths.map((path) => `:(literal)${path}`);
  if (await resourcesUseSymlinks(worktree.root, paths, pathspecs)) return "undecided";
  if (await resourcesDiffer(worktree.root, worktree.mainHead, pathspecs)) return "undecided";
  return "yes";
}
