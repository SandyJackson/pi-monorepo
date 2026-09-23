import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LoopSettings } from "./settings.ts";

export const RUN_STATE_VERSION = 3;
export const MAX_REPAIRS = 2;

export interface Issue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: "open" | "closed";
}

export interface Ticket extends Issue {
  blockers: Issue[];
  repairs: number;
  status: "pending" | "running" | "blocked" | "accepted";
  baseline?: string;
  commit?: string;
  feedback?: string;
}

export interface Session {
  name: string;
  path: string;
  log: string;
}

export interface RunState {
  version: typeof RUN_STATE_VERSION;
  name: string;
  repo: string;
  githubRepo: string;
  origin: string;
  runDir: string;
  worktree: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  head: string;
  check: string;
  setup?: string;
  timeoutMs: number;
  /** Resolved `--settings` snapshot. `resume` reuses it even if the source files change. */
  settings: LoopSettings;
  parent: Issue;
  tickets: Ticket[];
  sessions: Session[];
  finalRepairs: number;
  phase: "setup" | "tickets" | "final" | "publish" | "done";
  status: "running" | "blocked" | "done";
  currentTicket?: number;
  feedback?: string;
  lastError?: string;
  pr?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function atomicWrite(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function save(state: RunState): void {
  mkdirSync(state.runDir, { recursive: true, mode: 0o700 });
  atomicWrite(join(state.runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  const rows = state.tickets.map(
    (ticket) =>
      `| #${ticket.number} ${ticket.title.replaceAll("|", "\\|").replaceAll("\n", " ")} | ${ticket.status} | ${ticket.repairs}/${MAX_REPAIRS} | ${ticket.commit ?? ""} |`,
  );
  const active = state.tickets.find((ticket) => ticket.number === state.currentTicket);
  const cli = resolve(import.meta.dirname, "run.mjs");
  const sessions = state.sessions.map(
    (session) =>
      `- ${session.name}\n  - Log: ${session.log}\n  - Reopen: \`cd ${shellQuote(state.worktree)} && pi --session ${shellQuote(session.path)}\``,
  );
  writeFileSync(
    join(state.runDir, "summary.md"),
    [
      `# ${state.name}`,
      `Status: ${state.status}; phase: ${state.phase}`,
      state.pr ? `Pull request: ${state.pr}` : "",
      "",
      "| Ticket | Status | Repairs used | Accepted commit |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
      state.lastError ?? "No recorded failure.",
      active?.feedback ?? state.feedback ?? "",
      `Resume: \`node ${shellQuote(cli)} resume ${shellQuote(state.runDir)}\``,
      "",
      ...sessions,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

export function load(runDir: string): RunState {
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
  if (state.version !== RUN_STATE_VERSION) {
    throw new Error(
      "Unsupported run state version; older snapshots may include issue comments. Preserve any work and start a new run from reviewed issue bodies. Do not change the version by hand.",
    );
  }
  if (
    state.runDir !== resolve(runDir) ||
    !Array.isArray(state.tickets) ||
    !Array.isArray(state.sessions) ||
    !["setup", "tickets", "final", "publish", "done"].includes(state.phase) ||
    !["running", "blocked", "done"].includes(state.status)
  ) {
    throw new Error(
      "Unrecognized run state or moved run directory; inspect state.json before continuing",
    );
  }
  return state;
}
