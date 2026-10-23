// Interrupts, deadlines, and run-queue guards.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  readState,
  readWorkers,
  runDirFrom,
  writeWatchdogSettings,
} from "./cli-fixture.ts";

cliTest(
  "runs one loop through recovery, repairs, hooks, manual work, publication, and resume",
  async () => {
    const f = fixture("integrated");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ -f ticket-12.txt ] && [ ! -f hook-fixed.txt ]; then\n  echo "ticket-12.txt:1:1 error: INTEGRATED_LINT" >&2\n  exit 1\nfi\n`,
      { mode: 0o755 },
    );
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
    const start = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    ];

    // Run 1: #11 recovers a transient failure and is repaired in the review
    // conversation; #12 repairs a hook failure, then its review repair crashes.
    const first = await f.run(...start);
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const stopped = readState(runDir);
    expect(stopped.status).toBe("blocked");
    const [ticket11, ticket12] = stopped.tickets;
    expect(ticket11.status).toBe("accepted");
    expect(ticket11.repairs).toBe(1);
    expect(ticket12.status).toBe("blocked");
    expect(ticket12.phase).toBe("repair");
    const implement11 = stopped.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement"),
    );
    expect(implement11.transientRetries).toBe(1);
    const workers = readWorkers(f.root);
    const review11 = workers.find((worker) => worker.name.includes("#11 review"))!;
    const repair11 = workers.find((worker) => worker.name.includes("#11 repair"))!;
    expect(repair11.session).toBe(review11.session);
    expect(workers.filter((worker) => worker.name.includes("#11 audit"))).toHaveLength(1);
    const hookRepair = workers.find((worker) => worker.name.includes("#12 repair"))!;
    expect(hookRepair.prompt).toContain("INTEGRATED_LINT");

    // Run 2: the operator finishes #12 by hand. A fresh reviewer assesses it,
    // the PR is published, and the observations comment post loses its response.
    writeFileSync(join(stopped.worktree, "manual-12.txt"), "Manually fixed\n");
    const second = await f.run("resume", runDir);
    expect(second.status).toBe(1);
    const posted = readState(runDir);
    expect(posted.phase).toBe("publish");
    expect(posted.tickets.map((ticket: { status: string }) => ticket.status)).toEqual([
      "accepted",
      "accepted",
    ]);
    const reviews12 = readWorkers(f.root).filter((worker) => worker.name.includes("#12 review"));
    expect(reviews12).toHaveLength(2);
    expect(reviews12[1].session).not.toBe(reviews12[0].session);
    expect(reviews12[1].prompt).not.toContain("INTEGRATED_12 finding");
    const manualReviewPatch = readFileSync(join(f.root, "integrated-manual-review.patch"), "utf8");
    expect(manualReviewPatch).toContain("diff --git a/manual-12.txt b/manual-12.txt");
    expect(manualReviewPatch).toContain("+Manually fixed");

    // Run 3 reconciles the posted comment; run 4 changes nothing.
    const third = await f.run("resume", runDir);
    expect(third.status, third.stderr).toBe(0);
    const fourth = await f.run("resume", runDir);
    expect(fourth.status).toBe(0);
    expect(fourth.stdout).toContain("Already complete");

    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("[P3] Ticket 12 cleanup");
    expect(comments[0].body).toContain(finished.tickets[1].review.head);
    expect(
      readWorkers(f.root).filter((worker) => worker.name.includes("parent describe")),
    ).toHaveLength(1);
    // Unsquashed child history is left for the human to squash or merge: the
    // hook repair joins #12's feature commit and the manual fix is its fixup.
    expect(
      f.git(
        "-C",
        finished.worktree,
        "log",
        "--reverse",
        "--format=%s",
        `${finished.baseSha}..HEAD`,
      ),
    ).toBe(
      [
        "loop: #11 Ticket 11",
        "fixup! loop: #11 Ticket 11",
        "loop: #12 Ticket 12",
        "fixup! loop: #12 Ticket 12",
      ].join("\n"),
    );
    const files = (commit: string) =>
      f.git("-C", finished.worktree, "show", "--name-only", "--format=", commit).split("\n");
    expect(files(finished.tickets[1].anchor)).toEqual(
      expect.arrayContaining(["hook-fixed.txt", "ticket-12.txt"]),
    );
    expect(files("HEAD")).toContain("manual-12.txt");
  },
  60_000,
);

cliTest(
  "times out a held publication push at the configured Git deadline and keeps the accepted history",
  async () => {
    const f = fixture();
    const settings = join(f.root, "deadline-settings.json");
    writeFileSync(settings, JSON.stringify({ deadlines: { gitMs: 3_000 } }));
    // Delegate every Git call except publication, which holds until the controller's deadline.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(f.root, "bin", "git"),
      `#!/bin/sh\nif [ "$1" = "push" ]; then\n  touch "$FIXTURE_ROOT/push-started"\n  sleep 60\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o755 },
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
      settings,
    );
    expect(result.status).toBe(1);
    expect(existsSync(join(f.root, "push-started"))).toBe(true);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("blocked");
    expect(state.settings.deadlines.gitMs).toBe(3_000);
    expect(state.lastError).toContain("Timed out running git");
    // The commit accepted before publication stays in the worktree, and no PR is created.
    expect(f.git("-C", state.worktree, "rev-parse", "HEAD")).toBe(state.head);
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
  },
  30_000,
);

cliTest(
  "uses the snapshotted Git deadline for a held GitHub read on resume even if the settings file changes",
  async () => {
    // Resume reaches observations comment reconciliation without launching a worker.
    const f = fixture("comment-create-fail");
    const settings = join(f.root, "deadline-settings.json");
    writeFileSync(settings, JSON.stringify({ deadlines: { gitMs: 3_000 } }));
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
    // The operator later raises the source file; the run keeps the snapshot it started with.
    writeFileSync(settings, JSON.stringify({ deadlines: { gitMs: 600_000 } }));
    // Hold every gh call on resume; the real fake gh is moved aside for delegation.
    const bin = join(f.root, "bin");
    renameSync(join(bin, "gh"), join(f.root, "gh-fixture"));
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ -f "$FIXTURE_ROOT/hold-gh" ]; then\n  touch "$FIXTURE_ROOT/gh-held"\n  sleep 60\n  exit 0\nfi\nexec "$FIXTURE_ROOT/gh-fixture" "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(f.root, "hold-gh"), "");
    const launchesBeforeResume = readWorkers(f.root).length;
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    expect(existsSync(join(f.root, "gh-held"))).toBe(true);
    const state = readState(runDir);
    expect(state.status).toBe("blocked");
    expect(state.settings.deadlines.gitMs).toBe(3_000);
    expect(state.lastError).toContain("Timed out running gh");
    expect(readWorkers(f.root)).toHaveLength(launchesBeforeResume);
  },
  30_000,
);

cliTest(
  "reports a dependency cycle without starting a worker or publishing",
  async () => {
    const f = fixture("cycle");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.sessions).toEqual([]);
    expect(state.lastError).toContain("dependency cycle");
    expect(state.status).toBe("blocked");
  },
  30_000,
);

cliTest(
  "rejects an empty queue rather than claiming the parent is complete",
  async () => {
    const f = fixture("empty");
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No open direct child issues");
  },
  30_000,
);

cliTest(
  "stops a timed-out check instead of launching repair workers",
  async () => {
    const f = fixture("fail");
    const first = await f.start();
    expect(first.status, first.stderr).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const statePath = join(runDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.sessions).toHaveLength(1);
    writeFileSync(join(state.worktree, "feature.txt"), "Manually fixed\n");
    // Exercise real timeout handling on resume without the CLI's five-minute minimum.
    state.settings.deadlines.checkMs = 500;
    state.check = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('check-started', 'yes'); setInterval(() => {}, 1000)"`;
    writeFileSync(statePath, JSON.stringify(state));
    const result = await f.run("resume", runDir);
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(join(state.worktree, "check-started"), "utf8")).toBe("yes");
    const stopped = JSON.parse(readFileSync(statePath, "utf8"));
    expect(stopped.status).toBe("blocked");
    expect(stopped.sessions).toHaveLength(1);
    expect(stopped.lastError).toContain("Timed out running /bin/sh");
    expect(readWorkers(f.root)).toHaveLength(1);
  },
  30_000,
);

cliTest(
  "rejects a timeout below the CLI minimum before starting workers",
  async () => {
    const f = fixture();
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--timeout",
      "1",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--timeout must be 300 to 7200 seconds");
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
  },
  30_000,
);
