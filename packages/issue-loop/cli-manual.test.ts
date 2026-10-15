// Manual fixes reviewed and repaired as fresh work.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "reviews manually fixed work on resume instead of resuming the stale repairer",
  async () => {
    const f = fixture("manual-repair");
    const check = `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.tickets[0].phase).toBe("repair");
    const repair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].status).toBe("accepted");
    // The interrupted repairer is never reopened; a fresh reviewer assesses the
    // manual work and only then becomes the repairer if changes are requested.
    const workers = readWorkers(f.root);
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    expect(repairs).toHaveLength(1);
    expect(reviews).toHaveLength(2);
    expect(workers.filter((worker) => worker.name.includes("#11 audit"))).toHaveLength(1);
    expect(reviews[1].session).not.toBe(repair.session);
    expect(reviews[1].prompt).not.toContain("INTERRUPTED_REPAIR finding");
    // Ticket #12 later overwrites feature.txt, so inspect the accepted #11 tree.
    expect(
      f.git("-C", finished.worktree, "show", `${finished.tickets[0].commit}:feature.txt`),
    ).toContain("Manually fixed");
  },
  30_000,
);

cliTest(
  "runs a fresh reviewer before repairing manually fixed work with failing checks",
  async () => {
    const f = fixture("manual-repair");
    const check = `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').readFileSync('feature.txt','utf8').includes('implemented') ? 0 : 1)"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    // The operator fixes the work but the required check still fails.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "manual-repair-check";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].status).toBe("accepted");
    const workers = readWorkers(f.root);
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    // The resumed review sees the failure evidence and then repairs in its own
    // conversation; the stale crashed repairer is not reopened.
    expect(reviews[1].prompt).toContain("Check failure output");
    expect(repairs).toHaveLength(2);
    expect(reviews[1].session).toBe(repairs[1].session);
    expect(finished.tickets[0].repairs).toBe(2);
  },
  30_000,
);

cliTest(
  "starts a fresh reviewer after a blocked review when checks still fail on manual work",
  async () => {
    const f = fixture("blocked-review");
    const check = `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').readFileSync('feature.txt','utf8').includes('implemented') ? 0 : 1)"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.tickets[0].phase).toBe("review");
    expect(blocked.tickets[0].review.outcome).toBe("blocked");
    // The operator changes the work, but the required check still fails.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "manual-repair-check";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].status).toBe("accepted");
    const workers = readWorkers(f.root);
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    // The blocked review is never resumed. Manual work gets a fresh reviewer
    // that sees the failing checks and then repairs in its own conversation.
    const fresh = reviews.find((worker) => worker.prompt.includes("Check failure output"));
    expect(fresh).toBeTruthy();
    expect(fresh!.session).not.toBe(blocked.tickets[0].reviewConversation);
    expect(repairs.at(-1)!.session).toBe(fresh!.session);
  },
  30_000,
);

cliTest(
  "starts a fresh reviewer after a crashed review when the operator changed the work",
  async () => {
    const f = fixture("manual-review");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.tickets[0].phase).toBe("review");
    expect(blocked.tickets[0].review).toBeUndefined();
    const interrupted = readWorkers(f.root).find((worker) => worker.name.includes("#11 review"))!;
    expect(interrupted).toBeTruthy();
    // The operator changes the work so the required check passes again.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].status).toBe("accepted");
    const reviews = readWorkers(f.root).filter((worker) => worker.name.includes("#11 review"));
    // The interrupted review conversation is not reused; a fresh reviewer
    // assesses the manually changed artifact.
    expect(reviews).toHaveLength(2);
    expect(reviews[1].session).not.toBe(interrupted.session);
  },
  30_000,
);

cliTest(
  "recovers a crashed manual review on a second resume instead of the stale editor",
  async () => {
    const f = fixture("manual-repair");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.tickets[0].phase).toBe("repair");
    const staleRepair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    // The operator fixes the work, then the fresh reviewer fails.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "manual-review";
    const crashed = await f.run("resume", runDir);
    expect(crashed.status).toBe(1);
    const interrupted = readState(runDir);
    // The review handoff is persisted before the worker launches, so an
    // unchanged resume never reopens the stale repairer.
    expect(interrupted.tickets[0].phase).toBe("review");
    const freshReview = readWorkers(f.root)
      .filter((worker) => worker.name.includes("#11 review"))
      .at(-1)!;
    expect(freshReview.session).not.toBe(staleRepair.session);
    // A second unchanged resume recovers that review and its allowance.
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].repairs).toBe(1);
    const workers = readWorkers(f.root);
    expect(workers.filter((worker) => worker.name.includes("#11 repair"))).toHaveLength(1);
    expect(workers.filter((worker) => worker.name.includes("#11 review")).at(-1)!.session).toBe(
      freshReview.session,
    );
    // The operator's manual fix survives review and acceptance.
    expect(
      f.git("-C", finished.worktree, "show", `${finished.tickets[0].commit}:feature.txt`),
    ).toContain("Manually fixed");
  },
  30_000,
);

cliTest(
  "revalidates a cached pass and blocks when required checks fail after an interrupted audit",
  async () => {
    const f = fixture("manual-audit-check");
    const check = `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').existsSync(process.env.FIXTURE_ROOT + '/check-fail') ? 1 : 0)"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status, first.stderr).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.tickets[0].phase).toBe("repair");
    // The operator fixes the work so the check still passes; the fresh reviewer
    // passes but its latest-findings audit is interrupted.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    const auditCrash = await f.run("resume", runDir);
    expect(auditCrash.status, auditCrash.stderr).toBe(1);
    const interrupted = readState(runDir);
    expect(interrupted.tickets[0].phase).toBe("audit");
    expect(interrupted.tickets[0].review).toMatchObject({ outcome: "pass" });
    expect(interrupted.tickets[0].audit).toBeUndefined();
    // Required checks now fail on an unchanged resume.
    writeFileSync(join(f.root, "check-fail"), "fail\n");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(1);
    const finished = readState(runDir);
    expect(finished.status).toBe("blocked");
    expect(finished.tickets[0].status).not.toBe("accepted");
    expect(finished.tickets[0].commit).toBeUndefined();
    // The cached pass is re-validated against the failing checks with the
    // failure evidence, consuming exactly one bounded correction before the
    // inconsistent pass blocks the child.
    const reviews = readWorkers(f.root).filter((worker) => worker.name.includes("#11 review"));
    expect(reviews.some((worker) => worker.prompt.includes("Check failure output"))).toBe(true);
    expect(reviews.some((worker) => worker.prompt.includes("could not accept"))).toBe(true);
    const failedReview = finished.sessions
      .filter(
        (session: { phaseTask?: string }) =>
          session.phaseTask === interrupted.tickets[0].reviewTask,
      )
      .at(-1);
    expect(failedReview.corrections).toBe(1);
    // The stale passing audit is never reused to accept the failed checks; the
    // cached pass is re-validated instead.
    expect(Number(readFileSync(join(f.root, "manual-audit-count"), "utf8"))).toBe(1);
  },
  30_000,
);

cliTest(
  "resumes a repair that saved files before failing without spending a repair round",
  async () => {
    const f = fixture("repair-partial-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.tickets[0].phase).toBe("repair");
    expect(blocked.tickets[0].repairs).toBe(1);
    const repair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    // Resume without any operator edit: the saved repair files are execution
    // recovery, so the same repair conversation resumes rather than a review
    // that would spend another code-repair round.
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].repairs).toBe(1);
    const repairs = readWorkers(f.root).filter((worker) => worker.name.includes("#11 repair"));
    expect(repairs).toHaveLength(2);
    expect(repairs[1].session).toBe(repair.session);
    // The resumed controller and worker process reload the session file: the reviewer's
    // prompt and outcome, then the interrupted repair's prompt, with no new prompt yet.
    const review = readWorkers(f.root).find((worker) => worker.name.includes("#11 review"))!;
    expect(historyText(repairs[1].historyBefore, "user")).toEqual([review.prompt, repair.prompt]);
    expect(historyText(repairs[1].historyBefore, "assistant")).toHaveLength(1);
  },
  30_000,
);

cliTest(
  "recovers an interrupted repair after a manual descendant without renewing its budgets",
  async () => {
    const f = fixture("repair-partial-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const statePath = join(runDir, "state.json");
    const initial = JSON.parse(readFileSync(statePath, "utf8"));
    const anchor = initial.tickets[0].anchor;
    expect(anchor).toBeTruthy();
    rmSync(join(initial.worktree, "repair-partial.txt"));
    writeFileSync(join(initial.worktree, "operator.txt"), "Manual descendant\n");
    f.git("-C", initial.worktree, "add", "-A");
    f.git("-C", initial.worktree, "commit", "-m", "Manual descendant");
    const manual = f.git("-C", initial.worktree, "rev-parse", "HEAD");

    const second = await f.run("resume", runDir);
    expect(second.status).toBe(1);
    const stopped = JSON.parse(readFileSync(statePath, "utf8"));
    expect(stopped.tickets[0].phase).toBe("repair");
    expect(stopped.tickets[0].repairs).toBe(2);
    expect(stopped.tickets[0].anchor).toBe(anchor);
    const task = stopped.tickets[0].editTask;
    const conversation = stopped.tickets[0].editConversation;
    const latest = stopped.sessions.at(-1);
    expect(latest.phaseTask).toBe(task);
    // Model a durable checkpoint with already-consumed recovery allowances.
    latest.consumedMs = 1234;
    latest.continuationUsed = true;
    latest.transientRetries = 1;
    latest.corrections = 1;
    writeFileSync(statePath, JSON.stringify(stopped));
    const priorWorkers = readWorkers(f.root).length;

    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(statePath, "utf8"));
    const ticket = finished.tickets[0];
    expect(ticket.repairs).toBe(2);
    expect(ticket.baseline).toBe(initial.tickets[0].baseline);
    expect(ticket.anchor).toBe(anchor);
    expect(ticket.editTask).toBe(task);
    expect(ticket.editConversation).toBe(conversation);
    expect(readWorkers(f.root)[priorWorkers].name).toContain("#11 repair");
    const recovered = finished.sessions
      .filter((session: { phaseTask: string }) => session.phaseTask === task)
      .at(-1);
    expect(recovered.path).toBe(conversation);
    expect(recovered.consumedMs).toBeGreaterThanOrEqual(1234);
    expect(recovered.continuationUsed).toBe(true);
    expect(recovered.transientRetries).toBe(1);
    expect(recovered.corrections).toBe(1);
    expect(f.git("-C", finished.worktree, "merge-base", "--is-ancestor", manual, "HEAD")).toBe("");
  },
  30_000,
);

cliTest.each(["file edit", "same-tree commit"])(
  "starts fresh review when the operator makes a %s after an interrupted repair",
  async (change) => {
    const f = fixture("repair-partial-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const statePath = join(runDir, "state.json");
    const stopped = JSON.parse(readFileSync(statePath, "utf8"));
    const priorWorkers = readWorkers(f.root).length;
    if (change === "file edit") {
      writeFileSync(join(stopped.worktree, "operator.txt"), "Operator fix\n");
    } else {
      // A new HEAD is manual work even when every reviewable file is unchanged.
      f.git("-C", stopped.worktree, "commit", "--allow-empty", "-m", "Operator checkpoint");
    }
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readWorkers(f.root)[priorWorkers].name).toContain("#11 review");
    const finished = JSON.parse(readFileSync(statePath, "utf8"));
    expect(finished.tickets[0].repairs).toBe(2);
    expect(finished.tickets[0].editConversation).not.toBe(stopped.tickets[0].editConversation);
    expect(finished.tickets[0].anchor).toBe(stopped.tickets[0].anchor);
    expect(finished.tickets[0].baseline).toBe(stopped.tickets[0].baseline);
  },
  30_000,
);

cliTest.each([2, 1])(
  "routes manually reviewed partial work without bypassing the %i-round repair budget",
  async (repairRounds) => {
    const f = fixture("repair-partial-files-fail");
    const settings = join(f.root, "settings.json");
    writeFileSync(settings, JSON.stringify({ repairRounds }));
    const first = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settings,
    );
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const statePath = join(runDir, "state.json");
    const stopped = JSON.parse(readFileSync(statePath, "utf8"));
    const priorWorkers = readWorkers(f.root).length;
    // Preserve one verified file, leaving the interrupted worker's other file
    // unchanged and uncommitted. The whole content tree still matches the stop.
    f.git("-C", stopped.worktree, "add", "repair-partial.txt");
    f.git("-C", stopped.worktree, "commit", "-m", "Preserve verified partial repair");
    const manual = f.git("-C", stopped.worktree, "rev-parse", "HEAD");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    const subsequent = readWorkers(f.root).slice(priorWorkers);
    expect(subsequent[0].name).toContain("#11 review");
    expect(
      subsequent.some((worker) => worker.session === stopped.tickets[0].editConversation),
    ).toBe(false);
    if (repairRounds === 1) {
      expect(resumed.status).toBe(1);
      const blocked = JSON.parse(readFileSync(statePath, "utf8"));
      expect(blocked.lastError).toContain("exhausted its repair budget");
      expect(blocked.tickets[0].repairs).toBe(1);
      expect(blocked.tickets[0].status).not.toBe("accepted");
      expect(subsequent).toHaveLength(1);
      return;
    }
    expect(resumed.status, resumed.stderr).toBe(0);
    const completion = subsequent.find((worker) => worker.name.includes("#11 repair"))!;
    expect(completion.session).toBe(subsequent[0].session);
    expect(completion.prompt).toContain("not committable yet");
    const finished = JSON.parse(readFileSync(statePath, "utf8"));
    const ticket = finished.tickets[0];
    expect(ticket.repairs).toBe(2);
    expect(ticket.editTask).not.toBe(stopped.tickets[0].editTask);
    expect(ticket.editConversationRole).toBe("review");
    expect(ticket.anchor).toBe(stopped.tickets[0].anchor);
    expect(ticket.baseline).toBe(stopped.tickets[0].baseline);
    expect(
      f.git("-C", finished.worktree, "merge-base", "--is-ancestor", manual, ticket.commit),
    ).toBe("");
    expect(f.git("-C", finished.worktree, "show", `${ticket.commit}:repair-extra.txt`)).toBe(
      "extra partial",
    );
    const reviews = subsequent.filter((worker) => worker.name.includes("#11 review"));
    expect(reviews).toHaveLength(2);
    expect(reviews[1].session).not.toBe(completion.session);
  },
  30_000,
);

cliTest(
  "adopts a verified manual commit as the child anchor and targets fixups at it",
  async () => {
    const f = fixture("write-then-fail");
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(first.status, first.stderr).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.tickets[0].anchor).toBeUndefined();
    // The operator commits their manual implementation without rewriting anything.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually implemented\n");
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "Manual implementation");
    const manual = f.git("-C", blocked.worktree, "rev-parse", "HEAD");
    f.env.FIXTURE_MODE = "fixup";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    const ticket = finished.tickets[0];
    // The manual commit becomes the child anchor with its origin recorded...
    expect(ticket.anchor).toBe(manual);
    expect(ticket.anchorOrigin).toBe("manual");
    expect(ticket.repairCommits).toHaveLength(1);
    expect(ticket.commit).toBe(ticket.repairCommits[0]);
    // ...its subject and history stay unchanged, and later work fixes it up.
    expect(f.git("-C", finished.worktree, "log", "--format=%s", "-1", manual)).toBe(
      "Manual implementation",
    );
    expect(
      f.git("-C", finished.worktree, "log", "--format=%s", "-1", ticket.repairCommits[0]),
    ).toBe("fixup! Manual implementation");
    expect(f.git("-C", finished.worktree, "rev-parse", `${ticket.repairCommits[0]}^`)).toBe(manual);
  },
  30_000,
);

cliTest(
  "reviews a descendant manual commit with failing checks before repairing it",
  async () => {
    const f = fixture("write-then-fail");
    const check = `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').readFileSync('feature.txt','utf8').includes('implemented') ? 0 : 1)"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status, first.stderr).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "Manual fix");
    const manual = f.git("-C", blocked.worktree, "rev-parse", "HEAD");
    f.env.FIXTURE_MODE = "manual-repair-check";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    const ticket = finished.tickets[0];
    expect(finished.status).toBe("done");
    expect(ticket.anchor).toBe(manual);
    expect(ticket.anchorOrigin).toBe("manual");
    expect(ticket.repairCommits).toHaveLength(1);
    const workers = readWorkers(f.root);
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    // The fresh reviewer sees the failure evidence and the whole artifact, then
    // repairs in its own conversation instead of the stale editor.
    expect(reviews[0].prompt).toContain("Check failure output");
    expect(repairs).toHaveLength(1);
    expect(repairs[0].session).toBe(reviews[0].session);
  },
  30_000,
);

cliTest(
  "stops on ambiguous manual commits instead of guessing an anchor",
  async () => {
    const f = fixture("write-then-fail");
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(first.status, first.stderr).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    writeFileSync(join(blocked.worktree, "one.txt"), "one\n");
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "First manual commit");
    writeFileSync(join(blocked.worktree, "two.txt"), "two\n");
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "Second manual commit");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = readState(runDir);
    expect(after.status).toBe("blocked");
    expect(after.lastError).toContain("ambiguous");
    // No guessed anchor, no controller commit, and no worker launched: the
    // operator has to resolve the attribution by hand.
    expect(after.tickets[0].anchor).toBeUndefined();
    expect(after.tickets[0].commit).toBeUndefined();
    expect(readWorkers(f.root)).toHaveLength(1);
  },
  30_000,
);

cliTest(
  "refuses a rewritten accepted ancestry on resume",
  async () => {
    const f = fixture("publish-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(
      blocked.tickets.every((ticket: { status: string }) => ticket.status === "accepted"),
    ).toBe(true);
    const accepted = blocked.head;
    // Rewriting accepted history creates a new commit that no longer descends
    // from the recorded accepted SHA.
    f.git("-C", blocked.worktree, "commit", "--amend", "-m", "Rewritten accepted work");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = readState(runDir);
    expect(after.status).toBe("blocked");
    expect(after.lastError).toContain("rewritten");
    // The rewritten work is preserved rather than discarded.
    expect(f.git("-C", after.worktree, "log", "--format=%s", "-1")).toBe("Rewritten accepted work");
    expect(accepted).not.toBe(f.git("-C", after.worktree, "rev-parse", "HEAD"));
  },
  30_000,
);

cliTest(
  "refuses a switched worktree branch on resume",
  async () => {
    const f = fixture("fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    f.git("-C", blocked.worktree, "checkout", "-b", "operator-branch");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = readState(runDir);
    expect(after.status).toBe("blocked");
    expect(after.lastError).toContain("feature branch");
  },
  30_000,
);

cliTest(
  "reviews and commits staged manual changes through normal hooks",
  async () => {
    const f = fixture("write-then-fail");
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(first.status, first.stderr).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    // The operator stages a manual fix instead of leaving it unstaged.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Staged manual fix\n");
    f.git("-C", blocked.worktree, "add", "feature.txt");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    const ticket = finished.tickets[0];
    expect(finished.status).toBe("done");
    expect(ticket.status).toBe("accepted");
    expect(ticket.anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(f.git("-C", finished.worktree, "show", `${ticket.anchor}:feature.txt`)).toContain(
      "Staged manual fix",
    );
  },
  30_000,
);
