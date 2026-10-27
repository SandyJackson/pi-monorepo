/**
 * launch.ts — `ensureLive` (§7), shared by the parent runtime and the CLI.
 *
 * Tmux session-name uniqueness on the private server is the single-writer
 * mechanism: with one pane per session and `remain-on-exit off`, a live
 * session means a live Pi process.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { ChildId, Store } from "./store.ts";
import {
  buildNewSessionArgs,
  buildPiArguments,
  environmentNames,
  launchEnvironment,
  sessionTarget,
  TMUX_CONF,
  type TmuxExec,
  updateEnvironmentNames,
} from "./tmux.ts";

export type EnsureLiveResult =
  | { status: "live"; nonce: string }
  | { status: "failed"; error: string }
  | { status: "indeterminate"; error: string };

/** How long a launched child has to write `status.json` with its nonce. */
export const READY_MS = 30_000;
const READY_POLL_MS = 200;

/**
 * Abortable sleep on the global timer, so fake timers control it. Abort
 * resolves rather than rejects so polling loops re-check at their top.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function isLive(tmux: TmuxExec, childId: ChildId): Promise<boolean> {
  return (await tmux(["has-session", "-t", sessionTarget(childId)])).code === 0;
}

/**
 * Whether any client is attached to a child's session. Output that is not an
 * integer (a missing session prints an empty line) counts as attached, never as 0.
 */
export async function isAttached(tmux: TmuxExec, childId: ChildId): Promise<boolean> {
  const result = await tmux([
    "display-message",
    "-p",
    "-t",
    `${sessionTarget(childId)}:`,
    "#{session_attached}",
  ]);
  const count = result.stdout.trim();
  return !(result.code === 0 && /^[0-9]+$/.test(count) && Number(count) === 0);
}

/** The launch nonce of a child's live session, or `undefined` when it has none. */
export async function readNonce(tmux: TmuxExec, childId: ChildId): Promise<string | undefined> {
  const result = await tmux([
    "show-environment",
    "-t",
    sessionTarget(childId),
    "PI_SUBAGENT_NONCE",
  ]);
  const prefix = "PI_SUBAGENT_NONCE=";
  const line = result.stdout.replace(/\n$/, "");
  return result.code === 0 && line.startsWith(prefix) ? line.slice(prefix.length) : undefined;
}

export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureLive(
  childId: ChildId,
  deps: { store: Store; tmux: TmuxExec; env?: NodeJS.ProcessEnv },
): Promise<EnsureLiveResult> {
  const { store, tmux } = deps;
  const child = store.readChild(childId);

  let nonce: string | undefined;
  if (await isLive(tmux, childId)) {
    nonce = await readNonce(tmux, childId);
  } else {
    // From another cwd, Pi would silently start a new empty session with this ID.
    if (!isDirectory(child.cwd)) {
      return {
        status: "failed",
        error: `The child's cwd ${child.cwd} is not an existing directory.`,
      };
    }
    const launchNonce = randomBytes(16).toString("hex");
    const confPath = store.writeTmuxConf(TMUX_CONF);
    const childDir = store.childDir(childId);
    const env = launchEnvironment(deps.env ?? process.env);
    // A server started by another launcher holds that launcher's environment.
    const global = await tmux(["show-environment", "-g"], { env });
    const globalNames = global.code === 0 ? environmentNames(global.stdout) : [];
    const started = await tmux(
      buildNewSessionArgs({
        confPath,
        childId,
        cwd: child.cwd,
        nonce: launchNonce,
        variables: updateEnvironmentNames(env, globalNames),
        command: [...child.piCommand, ...buildPiArguments(child, childDir)],
      }),
      { env },
    );
    if (started.code === 0) {
      nonce = launchNonce;
    } else if (started.stderr.includes("duplicate session")) {
      // Another launcher won the race; wait for its process instead.
      nonce = await readNonce(tmux, childId);
    } else {
      const detail = started.stderr.trim() || `exit ${started.code}`;
      return { status: "failed", error: `tmux could not start the child: ${detail}` };
    }
  }
  if (nonce === undefined) {
    return {
      status: "indeterminate",
      error: `Child ${childId} has a live session without a launch nonce.`,
    };
  }

  const deadline = Date.now() + READY_MS;
  let statusError: string | undefined;
  for (;;) {
    try {
      if (store.readStatus(childId)?.nonce === nonce) return { status: "live", nonce };
    } catch (error) {
      statusError = error instanceof Error ? error.message : String(error);
    }
    if (!(await isLive(tmux, childId))) {
      return { status: "failed", error: `Child ${childId} exited before it was ready.` };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const suffix = statusError ? ` Last status error: ${statusError}` : "";
      return {
        status: "indeterminate",
        error: `Child ${childId} is running but did not report readiness within ${READY_MS / 1000} s.${suffix}`,
      };
    }
    await sleep(Math.min(READY_POLL_MS, remaining));
  }
}
