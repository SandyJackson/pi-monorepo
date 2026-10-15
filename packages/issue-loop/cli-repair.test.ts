// Reviewer-conversation repairs, audits, and retractions.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  historyText,
  readState,
  readWorkers,
  runDirFrom,
} from "./cli-fixture.ts";

cliTest(
  "creates a feature anchor and fixup history for changed child repairs",
  async () => {
    const f = fixture("fixup");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const ticket = state.tickets[0];
    expect(ticket.baseline).toBe(state.baseSha);
    expect(ticket.anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(ticket.repairCommits).toHaveLength(1);
    expect(ticket.workHead).toBe(ticket.repairCommits[0]);
    // Acceptance is recorded separately from the work commits that built it.
    expect(ticket.commit).toBe(ticket.workHead);
    expect(ticket.anchor).not.toBe(ticket.commit);
    // The failed first assessment survives the feature/fixup cycle, still
    // linked to the anchor it reviewed, alongside the later passing verdict.
    expect(ticket.reviews).toHaveLength(1);
    expect(ticket.reviews[0]).toMatchObject({ outcome: "changes_requested" });
    expect(ticket.reviews[0].head).toBe(ticket.anchor);
    expect(ticket.reviews[0].tree).toBe(
      f.git("-C", state.worktree, "rev-parse", `${ticket.anchor}^{tree}`),
    );
    expect(ticket.reviews[0].findings[0]).toMatchObject({
      artifact: { head: ticket.anchor, tree: ticket.reviews[0].tree },
    });
    expect(ticket.review).toMatchObject({ outcome: "pass" });
    expect(
      f.git(
        "-C",
        state.worktree,
        "log",
        "--format=%s",
        "--reverse",
        `${state.baseSha}..${ticket.commit}`,
      ),
    ).toBe([`loop: #11 Ticket 11`, `fixup! loop: #11 Ticket 11`].join("\n"));
    // The second review saw the whole cumulative delta, not only the fixup.
    const patch = readFileSync(join(runDir, "review.patch"), "utf8");
    expect(patch).toContain("first.txt");
    expect(patch).toContain("second.txt");
  },
  30_000,
);

cliTest(
  "repairs findings in the reviewer conversation and audits them independently",
  async () => {
    const f = fixture("fixup");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const workers = readWorkers(f.root);
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    const audits = workers.filter((worker) => worker.name.includes("#11 audit"));
    expect(reviews).toHaveLength(2);
    expect(repairs).toHaveLength(1);
    expect(audits).toHaveLength(1);
    // The first assessment is independent: no prior findings or repair notes.
    expect(reviews[0].prompt).not.toContain("Fix the first attempt");
    // The repair reopens the settled review conversation with additive editing
    // tools and repair skills, keeping the reviewer's model and thinking.
    expect(repairs[0].session).toBe(reviews[0].session);
    expect(reviews[1].session).not.toBe(reviews[0].session);
    expect(repairs[0].args[repairs[0].args.indexOf("--model") + 1]).toBe(
      state.settings.review.model,
    );
    expect(repairs[0].args[repairs[0].args.indexOf("--thinking") + 1]).toBe(
      state.settings.review.thinking,
    );
    const tools = repairs[0].args[repairs[0].args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls", "bash", "edit", "write"]),
    );
    expect(repairs[0].args).toContain("--no-skills");
    expect(repairs[0].args.some((arg) => arg.endsWith(join("skills", "tdd")))).toBe(true);
    expect(repairs[0].prompt).toContain("Fix the first attempt");
    // The repair loads the reviewer's persisted history from disk: its own earlier
    // prompt and assistant outcome, identified by role rather than by text that also
    // appears in the new feedback.
    expect(historyText(repairs[0].historyBefore, "user")).toEqual([reviews[0].prompt]);
    expect(historyText(repairs[0].historyBefore, "assistant")).toHaveLength(1);
    expect(historyText(repairs[0].historyBefore, "assistant")[0]).toContain(
      "Fix the first attempt",
    );
    // A fresh independent reviewer assesses the repaired artifact and again
    // sees no prior findings.
    expect(reviews[1].prompt).not.toContain("Fix the first attempt");
    expect(reviews[0].historyBefore).toEqual([]);
    expect(reviews[1].historyBefore).toEqual([]);
    // The audit shares the fresh reviewer's conversation and sees only the
    // latest failed findings plus the intervening repair explanation.
    expect(audits[0].session).toBe(reviews[1].session);
    expect(audits[0].prompt).toContain("Fix the first attempt");
    expect(audits[0].prompt).toContain("Intervening repair/retraction explanation");
    // The audit continues the fresh reviewer's conversation, not the repairer's.
    expect(historyText(audits[0].historyBefore, "user")).toEqual([reviews[1].prompt]);
    expect(state.tickets[0].audit).toMatchObject({ outcome: "pass" });
    expect(state.tickets[0].review).toMatchObject({ outcome: "pass" });
    // The review and its audit share one phase-task budget; the authorized
    // repair started a separate one in the same conversation.
    const review2 = [...state.sessions]
      .reverse()
      .find(
        (session: { kind: string; ticket?: number }) =>
          session.kind === "review" && session.ticket === 11,
      );
    const repairSession = state.sessions.find(
      (session: { kind: string; ticket?: number }) =>
        session.kind === "repair" && session.ticket === 11,
    );
    const auditSession = state.sessions.find(
      (session: { kind: string; ticket?: number }) =>
        session.kind === "audit" && session.ticket === 11,
    );
    expect(auditSession.phaseTask).toBe(review2.phaseTask);
    expect(repairSession.phaseTask).not.toBe(review2.phaseTask);
    expect(auditSession.consumedMs).toBeGreaterThanOrEqual(review2.consumedMs);
  },
  30_000,
);

cliTest(
  "returns failed checks to the last editing conversation and spends one repair round",
  async () => {
    const f = fixture("repair-check");
    const check = `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('check-ok')"`;
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const workers = readWorkers(f.root);
    const initial = workers.find((worker) => worker.name.includes("#11 implement"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    expect(repairs).toHaveLength(1);
    // The check-failure repair returned to the implement conversation rather
    // than starting a fresh editing session.
    expect(repairs[0].session).toBe(initial!.session);
    expect(repairs[0].prompt).toContain("Checks failed");
    expect(state.tickets[0].repairs).toBe(1);
    expect(state.tickets[0].status).toBe("accepted");
  },
  30_000,
);

cliTest(
  "records a no-change retraction, spends a repair round, and audits it",
  async () => {
    const f = fixture("retraction");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const ticket = state.tickets[0];
    expect(ticket.repairs).toBe(1);
    expect(ticket.retraction).toContain("finding is mistaken");
    // A no-change retraction manufactures no fixup commit.
    expect(ticket.repairCommits).toBeUndefined();
    const workers = readWorkers(f.root);
    expect(workers.filter((worker) => worker.name.includes("#11 repair"))).toHaveLength(1);
    const audits = workers.filter((worker) => worker.name.includes("#11 audit"));
    expect(audits).toHaveLength(1);
    expect(audits[0].prompt).toContain("finding is mistaken");
    expect(ticket.audit).toMatchObject({ outcome: "pass" });
  },
  30_000,
);

cliTest(
  "audits only the latest failed review's findings",
  async () => {
    const f = fixture("two-failures");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const ticket = state.tickets[0];
    expect(ticket.repairs).toBe(2);
    expect(ticket.reviews.map((review: { outcome: string }) => review.outcome)).toEqual([
      "changes_requested",
      "changes_requested",
    ]);
    expect(ticket.audit).toMatchObject({ outcome: "pass" });
    const workers = readWorkers(f.root);
    const rounds = workers.filter((worker) => worker.name.includes("#11 review"));
    expect(rounds).toHaveLength(3);
    // The third independent assessment sees neither earlier failure.
    expect(rounds[2].prompt).not.toContain("FIRST_FAILURE finding");
    expect(rounds[2].prompt).not.toContain("SECOND_FAILURE finding");
    // The audit receives only the latest failed findings.
    const audits = workers.filter((worker) => worker.name.includes("#11 audit"));
    expect(audits).toHaveLength(1);
    expect(audits[0].prompt).toContain("SECOND_FAILURE finding");
    expect(audits[0].prompt).not.toContain("FIRST_FAILURE finding");
  },
  30_000,
);

cliTest(
  "audits the latest failed review after an intervening passing assessment",
  async () => {
    const f = fixture("stale-failure");
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    const ticket = blocked.tickets[0];
    // A failed review, a repair, and a passing assessment whose audit was
    // blocked. The archived pass must not hide the unresolved finding.
    expect(ticket.review.outcome).toBe("pass");
    expect(ticket.reviews.map((review: { outcome: string }) => review.outcome)).toEqual([
      "changes_requested",
    ]);
    expect(ticket.audit).toMatchObject({ outcome: "blocked" });
    // The operator edit archives the passing assessment after the failure.
    writeFileSync(join(blocked.worktree, "operator.txt"), "Operator edit\n");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].audit).toMatchObject({ outcome: "pass" });
    // The resumed audit must target the earlier failed finding, not the pass.
    const audits = readWorkers(f.root).filter((worker) => worker.name.includes("#11 audit"));
    expect(audits).toHaveLength(2);
    expect(audits[1].prompt).toContain("STALE_FAILURE finding");
  },
  30_000,
);

cliTest(
  "uses dedicated repair guidance and skills while keeping the reviewer model",
  async () => {
    const f = fixture("fixup");
    const dir = join(f.root, "repair-settings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "repair.md"),
      `---
description: Test repairer
tools: read, bash, edit
---

CUSTOM REPAIR GUIDANCE.`,
      "utf8",
    );
    const settingsPath = join(dir, "loop-settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ repairAgent: "./repair.md", repairSkills: ["diagnosing-bugs"] }),
      "utf8",
    );
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.settings.repair).toMatchObject({
      promptBody: "CUSTOM REPAIR GUIDANCE.",
      tools: ["read", "bash", "edit"],
      skills: ["diagnosing-bugs"],
    });
    const repair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    expect(repair.prompt).toContain("CUSTOM REPAIR GUIDANCE.");
    expect(repair.args).toContain("--no-skills");
    expect(repair.args.some((arg) => arg.endsWith(join("skills", "diagnosing-bugs")))).toBe(true);
    // The custom repair tools are additive to the review conversation's tools.
    const tools = repair.args[repair.args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "bash", "edit"]));
    // The reviewer's model and thinking are not silently switched.
    expect(repair.args[repair.args.indexOf("--model") + 1]).toBe(state.settings.review.model);
  },
  30_000,
);
