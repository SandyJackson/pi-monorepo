import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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

/**
 * Pi config can reference extensions and skills anywhere, so its loaded content
 * cannot be verified by comparing fixed paths. Its presence always defers to Pi.
 */
function hasPiConfig(cwd: string): boolean {
  return PI_CONFIG_RESOURCES.some((entry) => existsSync(join(cwd, ".pi", entry)));
}

/** Paths, relative to the worktree root, of every `.agents/skills` directory Pi would load from cwd. */
function skillPaths(worktreeRoot: string, cwd: string): string[] {
  const paths: string[] = [];
  for (let dir = relative(worktreeRoot, cwd); ; dir = dirname(dir)) {
    paths.push(join(dir, ".agents", "skills"));
    if (dir === "" || dir === ".") break;
  }
  return paths;
}

/**
 * Files under the skill directories as Pi reads them, relative to the worktree
 * root. Undefined when they hold anything other than plain files and
 * directories, or are reached through a symlink. Symlinks are never followed,
 * so the walk stays inside the worktree.
 */
function readSkillFiles(worktreeRoot: string, paths: string[]): string[] | undefined {
  const files: string[] = [];
  const pending = paths.filter((path) => existsSync(join(worktreeRoot, path)));
  if (pending.some((path) => realpathSync(join(worktreeRoot, path)) !== join(worktreeRoot, path)))
    return undefined;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (!statSync(join(worktreeRoot, dir)).isDirectory()) return undefined;
    for (const entry of readdirSync(join(worktreeRoot, dir), { withFileTypes: true })) {
      if (entry.isFile()) files.push(join(dir, entry.name));
      else if (entry.isDirectory()) pending.push(join(dir, entry.name));
      else return undefined;
    }
  }
  return files;
}

/**
 * True when the skill files on disk are exactly the files of the main
 * worktree's HEAD under the same paths, byte for byte. Hashing the files
 * directly, rather than asking `git diff` or the index, means attributes,
 * filters, index flags and nested repositories cannot hide a change.
 */
async function skillsMatchHead(
  worktreeRoot: string,
  mainHead: string,
  paths: string[],
): Promise<boolean> {
  const files = readSkillFiles(worktreeRoot, paths);
  if (!files) return false;

  const pathspecs = paths.map((path) => `:(literal)${path}`);
  const tree = await git(worktreeRoot, "ls-tree", "-r", "-z", mainHead, "--", ...pathspecs);
  const headBlobs = new Map<string, string>();
  // Entries read `<mode> <type> <object>\t<path>`; the path itself may contain tabs.
  for (const entry of tree.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    headBlobs.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]);
  }
  if (files.length !== headBlobs.size) return false;
  if (files.length === 0) return true;

  const hashOutput = await git(worktreeRoot, "hash-object", "--no-filters", "--", ...files);
  const hashes = hashOutput.split("\n");
  return files.every((file, index) => headBlobs.get(file) === hashes[index]);
}

/**
 * Decides project trust for a linked Git worktree by inheriting its repository's trust.
 *
 * Returns "yes" only when the repository's main worktree is trusted, cwd has
 * no Pi config, and the skill files Pi would load from cwd are identical to
 * the main worktree's HEAD. Anything else is "undecided", so Pi falls back to
 * saved decisions and its prompt.
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

  const canonicalCwd = realpathSync(cwd);
  if (hasPiConfig(canonicalCwd)) return "undecided";

  const paths = skillPaths(worktree.root, canonicalCwd);
  return (await skillsMatchHead(worktree.root, worktree.mainHead, paths)) ? "yes" : "undecided";
}
