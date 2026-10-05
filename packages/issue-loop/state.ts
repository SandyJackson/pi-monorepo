import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LoopSettings } from "./settings.ts";
import type { CheckpointEvidence, FindingAxis, PhaseOutcomeName } from "./worker.ts";

export const RUN_STATE_VERSION = 5;

export interface Issue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: "open" | "closed";
}

/** Exact reviewed artifact: tree preserves mutations that leave HEAD unchanged. */
export interface ArtifactIdentity {
  head: string;
  tree: string;
}

export type Severity = "critical" | "major" | "minor";

/** Controller-assigned, artifact-linked review finding. */
export interface Finding {
  id: number;
  axis: FindingAxis;
  severity: Severity;
  location: string;
  description: string;
  artifact: ArtifactIdentity;
}

export interface Review {
  outcome: "pass" | "changes_requested" | "incomplete" | "blocked";
  summary: string;
  findings: Finding[];
  remainingWork?: string;
  blockers?: string;
  head: string;
  tree: string;
}

export interface Ticket extends Issue {
  blockers: Issue[];
  repairs: number;
  status: "pending" | "running" | "blocked" | "accepted";
  /** Worker phase that most recently ran for this ticket. */
  phase?: "editing" | "review";
  baseline?: string;
  commit?: string;
  feedback?: string;
  review?: Review;
}

export interface Session {
  name: string;
  path: string;
  log: string;
  /** Execution time the phase task had consumed when it last stopped. */
  consumedMs?: number;
  /** Whether the single incomplete/stalled continuation was used. */
  continuationUsed?: boolean;
  /** Controller-recorded stop explanation from the watchdog or a worker failure. */
  stopReason?: string;
  /** Checkpoint evidence persisted before an abort, replayed on recovery. */
  checkpoint?: CheckpointEvidence;
  /** Phase outcome the worker returned; an interrupted attempt leaves this unset so resume reuses its allowance. */
  outcome?: PhaseOutcomeName;
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
  review?: Review;
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

function findingLines(review: Review): string[] {
  return review.findings.map(
    (finding) =>
      `- [${finding.axis}][${finding.severity}] ${finding.location}: ${finding.description}`,
  );
}

export function reviewObservations(state: RunState): string[] {
  const observations: string[] = [];
  const append = (title: string, review: Review | undefined) => {
    if (review?.outcome !== "pass" || review.findings.length === 0) return;
    const body = [review.summary, ...findingLines(review)].filter(Boolean).join("\n");
    if (!body.trim()) return;
    const fence = "`".repeat(
      (body.match(/`+/g) ?? []).reduce((length, ticks) => Math.max(length, ticks.length + 1), 3),
    );
    observations.push(
      `### ${title}`,
      `Reviewed HEAD: \`${review.head}\`; content tree: \`${review.tree}\`.`,
      "",
      fence,
      body,
      fence,
      "",
    );
  };
  for (const ticket of state.tickets) append(`#${ticket.number} ${ticket.title}`, ticket.review);
  append("Parent review", state.review);
  return observations.length
    ? [
        "## Review observations",
        "",
        "Historical observations from passing reviews; these may have been resolved by later changes.",
        "",
        ...observations,
      ]
    : [];
}

export function save(state: RunState): void {
  mkdirSync(state.runDir, { recursive: true, mode: 0o700 });
  atomicWrite(join(state.runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  const rows = state.tickets.map(
    (ticket) =>
      `| #${ticket.number} ${ticket.title.replaceAll("|", "\\|").replaceAll("\n", " ")} | ${ticket.status} | ${ticket.repairs}/${state.settings.repairRounds} | ${ticket.commit ?? ""} |`,
  );
  const active = state.tickets.find((ticket) => ticket.number === state.currentTicket);
  const cli = resolve(import.meta.dirname, "run.mjs");
  const sessions = state.sessions.map(
    (session) =>
      `- ${session.name}\n  - Log: ${session.log}\n  - Reopen: \`cd ${shellQuote(state.worktree)} && pi --session ${shellQuote(session.path)}\``,
  );
  const observations = reviewObservations(state);
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
      ...(observations.length ? ["", ...observations] : []),
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
      "Unsupported run state version; older snapshots may include issue comments or an incompatible worker contract. Preserve any work and start a new run from reviewed issue bodies. Do not change the version by hand.",
    );
  }
  if (
    state.runDir !== resolve(runDir) ||
    !Array.isArray(state.tickets) ||
    !Array.isArray(state.sessions) ||
    !state.settings?.repair ||
    !state.settings.watchdog ||
    !state.settings.deadlines ||
    !Number.isInteger(state.settings.repairRounds) ||
    !["setup", "tickets", "final", "publish", "done"].includes(state.phase) ||
    !["running", "blocked", "done"].includes(state.status)
  ) {
    throw new Error(
      "Unrecognized run state or moved run directory; inspect state.json before continuing",
    );
  }
  return state;
}
