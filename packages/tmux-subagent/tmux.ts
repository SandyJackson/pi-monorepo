/**
 * tmux.ts — the `TmuxExec` seam and argv builders for the private tmux
 * server and the child Pi command line (§7).
 *
 * Commands are always argv passed to `execFile`, never shell strings.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import type { ChildId, ChildRecord } from "./store.ts";

/** Run one tmux command on the private socket. Rejects only when tmux cannot be run. */
export type TmuxExec = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const DEFAULT_SOCKET = "pi-subagents";

/** Socket name of the private server; overridable so tests use a disposable server. */
export function tmuxSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_SUBAGENT_TMUX_SOCKET || DEFAULT_SOCKET;
}

export function createTmuxExec(socket: string = tmuxSocket(), binary = "tmux"): TmuxExec {
  return execTmux(binary, ["-L", socket]);
}

/**
 * The operator's tmux server, for the CLI's menus, messages, and floats.
 * Without an override, tmux finds it through `TMUX`, which `run-shell` sets.
 * `PI_SUBAGENT_OUTER_TMUX_SOCKET` names a disposable server for tests.
 */
export function createOuterTmuxExec(
  env: NodeJS.ProcessEnv = process.env,
  binary = "tmux",
): TmuxExec {
  const socket = env.PI_SUBAGENT_OUTER_TMUX_SOCKET;
  return execTmux(binary, socket ? ["-L", socket] : []);
}

function execTmux(binary: string, socketArgs: string[]): TmuxExec {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        [...socketArgs, ...args],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
        },
      );
    });
}

/** Exact-match tmux target for a child's session. */
export function sessionTarget(childId: ChildId): string {
  return `=sa-${childId}`;
}

/** The private server's configuration. The user's tmux configuration is never loaded. */
export const TMUX_CONF = [
  "set -g prefix None",
  "set -g prefix2 None",
  "unbind-key -a -T root",
  "unbind-key -a -T prefix",
  "set -g status off",
  "set -s escape-time 0",
  "set -s extended-keys on",
  "set -s extended-keys-format csi-u",
  "set -s exit-empty on",
  "set -s exit-unattached off",
  "set -g destroy-unattached off",
  "set -g remain-on-exit off",
  "",
].join("\n");

const DROPPED_VARIABLES = new Set(["TMUX", "TMUX_PANE", "PI_SUBAGENT_NONCE"]);

/** The launcher's environment as passed to a child with `-e`. */
export function launchEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !DROPPED_VARIABLES.has(name)) result[name] = value;
  }
  return result;
}

export function buildNewSessionArgs(options: {
  confPath: string;
  childId: ChildId;
  cwd: string;
  nonce: string;
  env: Record<string, string>;
  command: readonly string[];
}): string[] {
  const args = [
    "-f",
    options.confPath,
    "new-session",
    "-d",
    "-s",
    `sa-${options.childId}`,
    "-c",
    options.cwd,
    "-e",
    `PI_SUBAGENT_NONCE=${options.nonce}`,
  ];
  for (const [name, value] of Object.entries(options.env)) args.push("-e", `${name}=${value}`);
  args.push("--", ...options.command);
  return args;
}

/** The child report tool, always allowed alongside an agent's tool allowlist. */
const CHILD_TOOLS = ["subagent_report"];

/** Pi arguments for a child, identical for first launch and resume. */
export function buildPiArguments(child: ChildRecord, childDir: string): string[] {
  const args = [
    "--session-dir",
    path.join(childDir, "session"),
    "--session-id",
    child.childId,
    "--no-mcp",
  ];
  if (child.agent.model) args.push("--model", child.agent.model);
  if (child.agent.thinking) args.push("--thinking", child.agent.thinking);
  const tools = child.agent.tools;
  if (tools !== undefined && tools.length > 0) {
    const extra = CHILD_TOOLS.filter((tool) => !tools.includes(tool));
    args.push("--tools", [...tools, ...extra].join(","));
  }
  args.push(child.projectTrust ? "--approve" : "--no-approve");
  args.push("--append-system-prompt", path.join(childDir, "system-prompt.md"));
  args.push("--subagent-child", childDir);
  return args;
}

/**
 * A child inherits project trust only when the parent's project is trusted and
 * the child's cwd is the parent's cwd or beneath it. Paths must be canonical.
 */
export function projectTrustFor(options: {
  parentTrusted: boolean;
  parentCwd: string;
  cwd: string;
}): boolean {
  if (!options.parentTrusted) return false;
  const relative = path.relative(options.parentCwd, options.cwd);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`);
  return !outside && !path.isAbsolute(relative);
}
