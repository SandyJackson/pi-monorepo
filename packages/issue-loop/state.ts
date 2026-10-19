import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactIdentity, CommitIntent } from "./artifact.ts";
import type { LoopSettings } from "./settings.ts";
import type { CheckpointEvidence, FindingAxis, PhaseOutcomeName, Priority } from "./worker.ts";

export const RUN_STATE_VERSION = 14;

export interface Issue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: "open" | "closed";
}

/**
 * A hook result that preserved uncommitted work. The controller refuses to
 * auto-commit or accept it until the artifact changes (an explicit manual fix
 * or a new editing phase); otherwise an unchanged resume would reconcile hook
 * leftovers as a fixup. The recovery slice later routes these to repair.
 */
export interface HookStop {
  reason: string;
  /** Content tree of the preserved work when the hook stopped. */
  tree: string;
}

/** Controller-assigned, artifact-linked review finding. */
export interface Finding {
  id: number;
  axis: FindingAxis;
  priority: Priority;
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

/** Persisted child phase, used to resume an authorized repair or review. */
export type TicketPhase = "implement" | "repair" | "review" | "audit";

export interface Ticket extends Issue {
  blockers: Issue[];
  repairs: number;
  status: "pending" | "running" | "blocked" | "accepted";
  /** Worker phase that most recently ran or is pending for this ticket. */
  phase?: TicketPhase;
  /** Original child baseline: the accepted HEAD before this child started. */
  baseline?: string;
  /** Feature anchor commit: the first changed work commit for this child. */
  anchor?: string;
  /** Who produced the anchor commit: the controller or a verified manual commit. */
  anchorOrigin?: "controller" | "manual";
  /** Subsequent repair fixups targeting the anchor, oldest first. */
  repairCommits?: string[];
  /** HEAD after the latest child work commit (anchor or a later fixup). */
  workHead?: string;
  /** Accepted SHA. A work commit alone never implies acceptance. */
  commit?: string;
  /** Worktree content tree when the latest editing phase stopped without completing. */
  stoppedTree?: string;
  /** Latest controller-observed phase artifact, including manual HEADs not recorded as work commits. */
  resumeArtifact?: ArtifactIdentity;
  /** Unresolved hook outcome that preserved work and must not be auto-committed. */
  hookStop?: HookStop;
  feedback?: string;
  /** Latest artifact-linked primary review verdict; earlier verdicts remain in `reviews`. */
  review?: Review;
  /** Earlier artifact-linked review verdicts, oldest first. */
  reviews?: Review[];
  /** Read-only second pass confirming the latest failed review's findings on the unchanged artifact. */
  audit?: Review;
  /** Review rounds started, used to derive the next review phase-task identity. */
  reviewRounds?: number;
  /** Conversation (session file) hosting the current review round, its audit, and its repair. */
  reviewConversation?: string;
  /** Phase-task identity of the current review round; the audit shares its budget. */
  reviewTask?: string;
  /** Artifact identity the pending review/audit was attempted against; detects operator changes across a review stop. */
  reviewAttempt?: ArtifactIdentity;
  /** Manual work pending review: review it even when required checks fail instead of returning to a stale editor. */
  reviewOnCheckFailure?: boolean;
  /** Phase-task identity of the editing phase currently being worked. */
  editTask?: string;
  /** Conversation (session file) that hosts the current editing phase task. */
  editConversation?: string;
  /** Originating role of the editing conversation; keeps its model/thinking unchanged during repair. */
  editConversationRole?: "implement" | "review";
  /** Intervening repair/retraction explanation supplied to the latest-findings audit. */
  repairNote?: string;
  /** Explanation recorded when a repair round produced no artifact change (retraction). */
  retraction?: string;
}

export type SessionKind = "implement" | "review" | "repair" | "audit" | "describe";

export interface Session {
  name: string;
  /** Shared session file for every attempt in one worker conversation. */
  path: string;
  log: string;
  /** Ticket this conversation belongs to, or undefined for the parent conversation. */
  ticket?: number;
  /** Role guidance/config this attempt ran with. */
  kind: SessionKind;
  /** Originating role of the conversation; selects model/thinking for every attempt. */
  conversationRole: "implement" | "review" | "describe";
  /** Phase-task identity; attempts sharing it share one runtime budget. */
  phaseTask: string;
  /** Execution time the phase task had consumed when it last stopped. */
  consumedMs?: number;
  /** Whether the single incomplete/stalled continuation was used. */
  continuationUsed?: boolean;
  /** Controller transient retries consumed after Pi exhausted its native retries. */
  transientRetries?: number;
  /** Response correction attempts consumed for this phase task. */
  corrections?: number;
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
  /** Operator corrections snapshotted on resume, included in every subsequent worker prompt. */
  operatorInstructions?: string;
  setup?: string;
  /** Resolved `--settings` snapshot. `resume` reuses it even if the source files change. */
  settings: LoopSettings;
  parent: Issue;
  tickets: Ticket[];
  sessions: Session[];
  /** Required-check log for the publication artifact, shown to the PR-description worker. */
  finalCheckLog?: string;
  /**
   * Worker-written PR description for one publication HEAD, after closing
   * keywords were neutralized. A changed HEAD gets a fresh description.
   */
  prDescription?: { head: string; body: string };
  /** Observations PR comment id once posted, so resume can reconcile idempotently. */
  observationsCommentId?: number;
  /**
   * Login that owns the managed observations comment, persisted before the
   * first create and never cleared. Reconciliation uses it rather than the
   * account resuming, so changed authorization stops for recovery instead of
   * posting a duplicate under the same marker.
   */
  observationsCommentAuthor?: string;
  /**
   * Commit intent persisted before Git runs. On resume it is reconciled from
   * verified operation identity, lineage, and artifact data so a crash between
   * Git and state persistence never repeats or loses a commit.
   */
  pendingCommit?: CommitIntent;
  phase: "setup" | "tickets" | "final" | "describe" | "publish" | "done";
  status: "running" | "blocked" | "done";
  currentTicket?: number;
  /** Worktree content tree when the latest parent editing phase stopped without completing. */
  stoppedTree?: string;
  /** Unresolved parent hook outcome that preserved work and must not be auto-committed. */
  hookStop?: HookStop;
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

function findingLines(review: Review): string[] {
  return review.findings.map(
    (finding) =>
      `- [${finding.priority}][${finding.axis}] ${finding.location}: ${finding.description}`,
  );
}

/** P3 notes from each ticket's latest passing review, for the PR comment and summary. */
export function reviewObservations(state: RunState): string[] {
  const observations: string[] = [];
  for (const ticket of state.tickets) {
    const review = ticket.review;
    if (review?.outcome !== "pass" || review.findings.length === 0) continue;
    const body = [review.summary, ...findingLines(review)].filter(Boolean).join("\n");
    const fence = "`".repeat(
      (body.match(/`+/g) ?? []).reduce((length, ticks) => Math.max(length, ticks.length + 1), 3),
    );
    observations.push(
      `### #${ticket.number} ${ticket.title}`,
      `Reviewed HEAD: \`${review.head}\`; content tree: \`${review.tree}\`.`,
      "",
      fence,
      body,
      fence,
      "",
    );
  }
  return observations.length
    ? [
        "## Review observations",
        "",
        "Historical observations from reviews; these may have been resolved by later changes.",
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
      ...(state.operatorInstructions
        ? [
            "",
            "## Operator instructions (user-injected; persistent)",
            "",
            state.operatorInstructions,
            "",
          ]
        : []),
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
    !state.settings.describe ||
    !state.settings.watchdog ||
    !state.settings.recovery ||
    !state.settings.deadlines ||
    !Number.isInteger(state.settings.repairRounds) ||
    !["setup", "tickets", "final", "describe", "publish", "done"].includes(state.phase) ||
    !["running", "blocked", "done"].includes(state.status)
  ) {
    throw new Error(
      "Unrecognized run state or moved run directory; inspect state.json before continuing",
    );
  }
  return state;
}
