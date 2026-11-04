/**
 * cli.ts — the operator's worktree-wide list and stop commands (§10).
 *
 *   node cli.ts list  [--worktree <path>] [--json]
 *   node cli.ts stop  <childId> | --worktree <path>
 *
 * Runs under plain `node` (native type stripping). It imports only
 * `inspect.ts`, `store.ts`, `tmux.ts`, `launch.ts`, and the text-only
 * `model-text.ts`, never Pi runtime modules.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  displayLabel,
  type InspectDeps,
  type ListedChild,
  listChild,
  readChildren,
  stopChild,
} from "./inspect.ts";
import { isDirectory } from "./launch.ts";
import { type ChildId, type ChildRecord, createStore, owningWorktree } from "./store.ts";
import { createTmuxExec, tmuxSocket } from "./tmux.ts";

export interface CliDeps extends InspectDeps {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
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

/** The §3 owning worktree of `dir`. Errors rather than guessing when `dir` is unusable. */
function resolveWorktree(dir: string): string {
  if (!dir || !isDirectory(dir)) throw new Error(`Cannot resolve the worktree of "${dir}".`);
  return owningWorktree(dir);
}

function formatListing(listing: Listing): string {
  if (listing.groups.length === 0) return "No subagents for this worktree\n";
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

/** The children owned by `worktree`, oldest first. Unreadable records are named on stderr. */
function worktreeChildren(worktree: string, deps: CliDeps): ChildRecord[] {
  return readChildren(deps.store, (childId, error) =>
    deps.stderr(`Skipped child ${childId}: ${error}\n`),
  ).filter((child) => child.worktree === worktree);
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
    group.children.push(await listChild(child, deps));
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

async function stop(childId: ChildId, deps: CliDeps, quiet = false): Promise<void> {
  if (await stopChild(childId, deps)) deps.stdout(`Stopped ${childId}\n`);
  else if (!quiet) deps.stdout(`${childId} is not running\n`);
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
  try {
    switch (command) {
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
    socket,
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
