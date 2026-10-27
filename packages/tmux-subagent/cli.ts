/**
 * cli.ts — the operator's picker, inspection float, and stop command (§10).
 *
 *   node cli.ts pick  --pane <outer pane id>
 *   node cli.ts open  <childId> --pane <outer pane id>
 *   node cli.ts list  [--worktree <path>] [--json]
 *   node cli.ts stop  <childId> | --worktree <path>
 *
 * Runs under plain `node` (native type stripping). It imports only
 * `store.ts`, `tmux.ts`, and `launch.ts`, never Pi runtime modules.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureLive, isLive, readNonce } from "./launch.ts";
import {
  type ChildId,
  type ChildRecord,
  createStore,
  owningWorktree,
  type Store,
} from "./store.ts";
import {
  createOuterTmuxExec,
  createTmuxExec,
  sessionTarget,
  type TmuxExec,
  tmuxSocket,
} from "./tmux.ts";

export interface CliDeps {
  store: Store;
  /** The private server. */
  tmux: TmuxExec;
  /** The operator's server, where menus, messages, and floats are shown. */
  outer: TmuxExec;
  /** Private socket name, for the float's attach client. */
  socket: string;
  /** Argv prefix that runs this CLI, used by menu items. */
  cliCommand: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
}

type ChildState = "running" | "idle" | "blocked" | "stopped";

interface ListedChild {
  childId: ChildId;
  agent: string;
  label?: string;
  state: ChildState;
}

interface ListedGroup {
  title: string;
  children: ListedChild[];
}

interface Listing {
  worktree: string;
  groups: ListedGroup[];
}

class UsageError extends Error {}

const EMPTY_SCOPE = "No subagents for this worktree";

/** The §3 owning worktree of `dir`. Errors rather than guessing when `dir` is unusable. */
function resolveWorktree(dir: string): string {
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(dir).isDirectory();
  } catch {}
  if (!dir || !isDirectory) throw new Error(`Cannot resolve the worktree of "${dir}".`);
  return owningWorktree(dir);
}

async function childState(child: ChildRecord, deps: CliDeps): Promise<ChildState> {
  if (!(await isLive(deps.tmux, child.childId))) return "stopped";
  const nonce = await readNonce(deps.tmux, child.childId);
  const status = deps.store.readStatus(child.childId);
  // A live session without a status of its own launch is a Pi process still starting.
  if (nonce === undefined || status?.nonce !== nonce) return "running";
  return status.blocked ? "blocked" : status.state;
}

function formatListing(listing: Listing): string {
  if (listing.groups.length === 0) return `${EMPTY_SCOPE}\n`;
  const lines: string[] = [];
  for (const group of listing.groups) {
    lines.push(displayLabel(group.title));
    for (const child of group.children) {
      const fields = [child.childId, child.agent, child.state];
      if (child.label !== undefined) fields.push(displayLabel(child.label));
      lines.push(`  ${fields.join("  ")}`);
    }
  }
  return lines.map((line) => `${line}\n`).join("");
}

/**
 * The children owned by `worktree`, oldest first. A child whose record cannot
 * be read is named on stderr and skipped, so it cannot hide every other child.
 */
function worktreeChildren(worktree: string, deps: CliDeps): ChildRecord[] {
  const children: ChildRecord[] = [];
  for (const childId of deps.store.listChildIds()) {
    try {
      children.push(deps.store.readChild(childId));
    } catch (error) {
      deps.stderr(
        `Skipped child ${childId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return children
    .filter((child) => child.worktree === worktree)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function list(worktree: string, deps: CliDeps): Promise<Listing> {
  const children = worktreeChildren(worktree, deps);

  // Keyed by parent session ID. A grandchild's parent session ID is its creating child's ID.
  const parents = new Map<string, ListedGroup>();
  const creators = new Map<ChildId, ListedGroup>();
  for (const child of children) {
    const key = child.parent.sessionId;
    const groups = child.depth === 2 ? creators : parents;
    let group = groups.get(key);
    if (!group) {
      const title = child.depth === 2 ? `child ${key}` : (child.parent.name ?? key.slice(0, 8));
      group = { title, children: [] };
      groups.set(key, group);
    }
    group.children.push({
      childId: child.childId,
      agent: child.agent.name,
      ...(child.label === undefined ? {} : { label: child.label }),
      state: await childState(child, deps),
    });
  }

  // Each creating child's group follows the group that lists that child.
  const ordered: ListedGroup[] = [];
  const take = (childId: ChildId) => {
    const group = creators.get(childId);
    if (!group) return;
    creators.delete(childId);
    ordered.push(group);
  };
  for (const group of parents.values()) {
    ordered.push(group);
    for (const child of group.children) take(child.childId);
  }
  ordered.push(...creators.values());
  return { worktree, groups: ordered };
}

/** End a child's Pi process. Its records and transcript stay; the next request or `open` resumes it. */
async function stop(childId: ChildId, deps: CliDeps, quiet = false): Promise<void> {
  const killed = await deps.tmux(["kill-session", "-t", sessionTarget(childId)]);
  if (killed.code === 0) deps.stdout(`Stopped ${childId}\n`);
  else if (await isLive(deps.tmux, childId)) {
    throw new Error(`tmux could not stop ${childId}: ${killed.stderr.trim()}`);
  } else if (!quiet) deps.stdout(`${childId} is not running\n`);
}

// ---------------------------------------------------------------------------
// Operator's server
// ---------------------------------------------------------------------------

const MAX_LABEL_LENGTH = 40;
const MENU_KEYS = "123456789";

/** tmux expands formats in menu names, commands, and messages. */
function escapeFormat(text: string): string {
  return text.replaceAll("#", "##");
}

function displayLabel(label: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control characters
  const clean = label.replace(/[\x00-\x1f\x7f]/g, "");
  return clean.length > MAX_LABEL_LENGTH ? `${clean.slice(0, MAX_LABEL_LENGTH - 1)}…` : clean;
}

/** A shell word in double quotes; `$`, backquote, `"` and `\` are escaped. */
function shellQuote(word: string): string {
  return `"${word.replace(/["\\$`]/g, "\\$&")}"`;
}

/**
 * The tmux command a menu item runs. tmux single quotes have no escapes, so
 * the shell words use double quotes and a `'` cannot be represented.
 */
function openCommand(childId: ChildId, pane: string, deps: CliDeps): string {
  const shell = [...deps.cliCommand.map(shellQuote), "open", childId, "--pane", pane].join(" ");
  if (shell.includes("'")) throw new Error(`Cannot quote the CLI path for tmux: ${shell}`);
  return escapeFormat(`run-shell -b '${shell}'`);
}

function parsePane(value: string | true | undefined): string {
  if (typeof value !== "string" || !/^%[0-9]+$/.test(value)) {
    throw new UsageError("--pane needs a tmux pane ID such as %3.");
  }
  return value;
}

async function paneWorktree(pane: string, deps: CliDeps): Promise<string> {
  const result = await deps.outer(["display-message", "-p", "-t", pane, "#{pane_current_path}"]);
  if (result.code !== 0) {
    throw new Error(`Cannot read the path of pane ${pane}: ${result.stderr.trim()}`);
  }
  return resolveWorktree(result.stdout.replace(/\n$/, ""));
}

function menuItems(listing: Listing, pane: string, deps: CliDeps): string[] {
  if (listing.groups.length === 0) return [`-${EMPTY_SCOPE}`, "", ""];
  const items: string[] = [];
  let index = 0;
  for (const group of listing.groups) {
    if (items.length > 0) items.push("");
    items.push(`-${escapeFormat(displayLabel(group.title))}`, "", "");
    for (const child of group.children) {
      const fields = [child.childId, child.agent, child.state];
      if (child.label !== undefined) fields.push(displayLabel(child.label));
      items.push(
        escapeFormat(fields.join("  ")),
        MENU_KEYS[index++] ?? "",
        openCommand(child.childId, pane, deps),
      );
    }
  }
  return items;
}

async function pick(pane: string, deps: CliDeps): Promise<void> {
  const listing = await list(await paneWorktree(pane, deps), deps);
  const shown = await deps.outer([
    "display-menu",
    "-t",
    pane,
    "-T",
    "Subagents",
    "-x",
    "C",
    "-y",
    "C",
    // Disabled items start with "-", so options must end first.
    "--",
    ...menuItems(listing, pane, deps),
  ]);
  if (shown.code !== 0) throw new Error(`tmux could not show the menu: ${shown.stderr.trim()}`);
}

/**
 * Resume the child if needed, then float an attach client over the pane.
 * An indeterminate launch still has a live session, so it is shown: the
 * operator can see why it is not ready.
 */
async function open(childId: ChildId, pane: string, deps: CliDeps): Promise<void> {
  deps.store.readChild(childId);
  const live = await ensureLive(childId, { store: deps.store, tmux: deps.tmux, env: deps.env });
  if (live.status === "failed") throw new Error(live.error);
  const opened = await deps.outer([
    "new-pane",
    "-O",
    "-x",
    "90%",
    "-y",
    "90%",
    "-t",
    pane,
    "--",
    "env",
    "-u",
    "TMUX",
    "-u",
    "TMUX_PANE",
    "tmux",
    "-L",
    deps.socket,
    "attach",
    "-t",
    sessionTarget(childId),
  ]);
  if (opened.code !== 0) {
    throw new Error(
      `tmux could not open the float: ${opened.stderr.trim() || `exit ${opened.code}`}`,
    );
  }
}

/** Report a failure where the operator is looking: on the pane, and on stderr. */
async function showError(pane: string, error: string, deps: CliDeps): Promise<void> {
  await deps.outer(["display-message", "-t", pane, escapeFormat(`Subagents: ${error}`)]);
}

function parseOptions(args: string[], flags: string[], valued: string[]) {
  const options: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags.includes(arg)) options[arg] = true;
    else if (valued.includes(arg)) {
      const value = args[++index];
      if (value === undefined) throw new UsageError(`${arg} needs a value.`);
      options[arg] = value;
    } else if (arg.startsWith("--")) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { options, positional };
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  let pane: string | undefined;
  try {
    switch (command) {
      case "pick": {
        const { options } = parseOptions(rest, [], ["--pane"]);
        pane = parsePane(options["--pane"]);
        await pick(pane, deps);
        return 0;
      }
      case "open": {
        const { options, positional } = parseOptions(rest, [], ["--pane"]);
        pane = parsePane(options["--pane"]);
        const [childId, ...extra] = positional;
        if (childId === undefined || extra.length > 0) {
          throw new UsageError("Usage: open <childId> --pane <pane>");
        }
        await open(childId, pane, deps);
        return 0;
      }
      case "stop": {
        const { options, positional } = parseOptions(rest, [], ["--worktree"]);
        const dir = options["--worktree"];
        if (positional.length !== (dir === undefined ? 1 : 0)) {
          throw new UsageError("Usage: stop <childId> | --worktree <path>");
        }
        if (typeof dir === "string") {
          for (const child of worktreeChildren(resolveWorktree(dir), deps)) {
            await stop(child.childId, deps, true);
          }
        } else {
          await stop(deps.store.readChild(positional[0]).childId, deps);
        }
        return 0;
      }
      case "list": {
        const { options } = parseOptions(rest, ["--json"], ["--worktree"]);
        const dir = typeof options["--worktree"] === "string" ? options["--worktree"] : deps.cwd;
        const listing = await list(resolveWorktree(dir), deps);
        deps.stdout(
          options["--json"] ? `${JSON.stringify(listing, null, 2)}\n` : formatListing(listing),
        );
        return 0;
      }
      default:
        throw new UsageError(`Unknown command ${command ?? "(none)"}.`);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    deps.stderr(`${text}\n`);
    if (pane !== undefined) await showError(pane, text, deps);
    return error instanceof UsageError ? 2 : 1;
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return fs.realpathSync(script) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const socket = tmuxSocket();
  process.exitCode = await runCli(process.argv.slice(2), {
    store: createStore(),
    tmux: createTmuxExec(socket),
    outer: createOuterTmuxExec(),
    socket,
    cliCommand: [process.execPath, fileURLToPath(import.meta.url)],
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
