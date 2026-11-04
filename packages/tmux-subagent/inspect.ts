/**
 * inspect.ts — child listing with live state, the inspection float, and stop (§10).
 *
 * Shared by the `/subagents` picker and `cli.ts`, so it imports only
 * `store.ts`, `tmux.ts`, and `launch.ts`, never Pi runtime modules.
 */

import { ensureLive, isLive, readNonce } from "./launch.ts";
import type { ChildId, ChildRecord, Store } from "./store.ts";
import { sessionTarget, type TmuxExec } from "./tmux.ts";

export interface InspectDeps {
  store: Store;
  /** The private server. */
  tmux: TmuxExec;
  /** Private socket name, for binding the store and the float's attach client. */
  socket: string;
  env: NodeJS.ProcessEnv;
}

export type ChildState = "running" | "idle" | "blocked" | "stopped";

export interface ListedChild {
  childId: ChildId;
  agent: string;
  label?: string;
  state: ChildState;
}

/** A row of the picker: a child of this conversation, or a grandchild nested under it. */
export interface PickerChild extends ListedChild {
  nested: boolean;
}

const MAX_LABEL_LENGTH = 40;

/** A parent name or child label made safe to show: no control characters, bounded length. */
export function displayLabel(label: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control characters
  const clean = label.replace(/[\x00-\x1f\x7f]/g, "");
  return clean.length > MAX_LABEL_LENGTH ? `${clean.slice(0, MAX_LABEL_LENGTH - 1)}…` : clean;
}

export async function childState(child: ChildRecord, deps: InspectDeps): Promise<ChildState> {
  if (!(await isLive(deps.tmux, child.childId))) return "stopped";
  const nonce = await readNonce(deps.tmux, child.childId);
  const status = deps.store.readStatus(child.childId);
  // A live session without a status of its own launch is a Pi process still starting.
  if (nonce === undefined || status?.nonce !== nonce) return "running";
  return status.blocked ? "blocked" : status.state;
}

export async function listChild(child: ChildRecord, deps: InspectDeps): Promise<ListedChild> {
  return {
    childId: child.childId,
    agent: child.agent.name,
    ...(child.label === undefined ? {} : { label: child.label }),
    state: await childState(child, deps),
  };
}

/**
 * Every readable child, oldest first. A child whose record cannot be read is
 * passed to `onSkip` and left out, so it cannot hide every other child.
 */
export function readChildren(
  store: Store,
  onSkip: (childId: ChildId, error: string) => void,
): ChildRecord[] {
  const children: ChildRecord[] = [];
  for (const childId of store.listChildIds()) {
    try {
      children.push(store.readChild(childId));
    } catch (error) {
      onSkip(childId, error instanceof Error ? error.message : String(error));
    }
  }
  return children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The children of the conversation `sessionId`, each followed by its own
 * children. A grandchild's parent session ID is its creating child's ID.
 */
export async function conversationChildren(
  sessionId: string,
  deps: InspectDeps,
  onSkip: (childId: ChildId, error: string) => void,
): Promise<PickerChild[]> {
  const all = readChildren(deps.store, onSkip);
  const rows: PickerChild[] = [];
  for (const child of all) {
    if (child.depth !== 1 || child.parent.sessionId !== sessionId) continue;
    rows.push({ ...(await listChild(child, deps)), nested: false });
    for (const grandchild of all) {
      if (grandchild.depth !== 2 || grandchild.parent.sessionId !== child.childId) continue;
      rows.push({ ...(await listChild(grandchild, deps)), nested: true });
    }
  }
  return rows;
}

/**
 * End a child's Pi process. Its records and transcript stay; the next request
 * or open resumes it. Returns false when the child was not running.
 */
export async function stopChild(childId: ChildId, deps: InspectDeps): Promise<boolean> {
  deps.store.bindSocket(deps.socket);
  const killed = await deps.tmux(["kill-session", "-t", sessionTarget(childId)]);
  if (killed.code === 0) return true;
  if (await isLive(deps.tmux, childId)) {
    throw new Error(`tmux could not stop ${childId}: ${killed.stderr.trim()}`);
  }
  return false;
}

/**
 * Resume the child if needed, then float an attach client over `pane` on the
 * operator's server. Escape or Ctrl-C closes the float and leaves the child
 * running. An indeterminate launch still has a live session, so it is shown:
 * the operator can see why it is not ready.
 */
export async function openFloat(
  childId: ChildId,
  pane: string,
  outer: TmuxExec,
  deps: InspectDeps,
): Promise<void> {
  deps.store.bindSocket(deps.socket);
  deps.store.readChild(childId);
  const live = await ensureLive(childId, { store: deps.store, tmux: deps.tmux, env: deps.env });
  if (live.status === "failed") throw new Error(live.error);
  const opened = await outer([
    "new-pane",
    "-O",
    "-D",
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
