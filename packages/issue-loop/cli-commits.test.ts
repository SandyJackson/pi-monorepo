// Work commits, hooks, and crash reconciliation.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  readState,
  readWorkers,
  runDirFrom,
  startThenKillAfterCommit,
} from "./cli-fixture.ts";

cliTest(
  "creates no commit for a completed phase that changed nothing",
  async () => {
    const f = fixture("noop");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.head).toBe(state.baseSha);
    expect(f.git("-C", state.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("0");
    for (const ticket of state.tickets) {
      expect(ticket.anchor).toBeUndefined();
      expect(ticket.commit).toBe(state.baseSha);
    }
  },
  30_000,
);

cliTest(
  "records a work commit without accepting the ticket when review is blocked",
  async () => {
    const f = fixture("blocked-review");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const ticket = state.tickets[0];
    expect(ticket.anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(ticket.workHead).toBe(ticket.anchor);
    // A recorded work commit is not ticket acceptance.
    expect(ticket.commit).toBeUndefined();
    expect(ticket.status).toBe("blocked");
    expect(ticket.review).toMatchObject({ outcome: "blocked" });
    expect(f.git("-C", state.worktree, "log", "--format=%s", "-1", ticket.anchor)).toBe(
      "loop: #11 Ticket 11",
    );
  },
  30_000,
);

cliTest(
  "rechecks a clean hook mutation before review",
  async () => {
    const f = fixture("blocked-review");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\necho mutated >> feature.txt\ngit add feature.txt\n`,
      { mode: 0o755 },
    );
    const check = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs');fs.appendFileSync(process.env.FIXTURE_ROOT + '/checks.txt', 'x');process.stdout.write(fs.readFileSync('feature.txt','utf8'))"`;
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const ticket = state.tickets[0];
    expect(ticket.anchor).toMatch(/^[a-f0-9]{40}$/);
    // The hook-mutated committed tree is reviewed, so checks ran again first.
    expect(readFileSync(join(f.root, "checks.txt"), "utf8")).toHaveLength(2);
    expect(f.git("-C", state.worktree, "show", `${ticket.anchor}:feature.txt`)).toContain(
      "mutated",
    );
    // The reviewer gets the recheck log describing the tree it actually reads.
    const review = readWorkers(f.root).find((entry) => entry.name.includes("review"))!;
    const checkLog = review.prompt.match(/Successful check output: (.+)/)![1];
    expect(readFileSync(checkLog, "utf8")).toContain("mutated");
  },
  30_000,
);

cliTest(
  "stops without reconciling when a successful hook leaves the worktree dirty",
  async () => {
    const f = fixture("blocked-review");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho dirty >> feature.txt\n`, {
      mode: 0o755,
    });
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toContain("dirty after committing");
    expect(state.tickets[0].anchor).toMatch(/^[a-f0-9]{40}$/);
    // The recorded commit and the dirty-hook disposition are persisted together,
    // so a crash cannot leave leftovers unattributed for a later resume.
    expect(state.tickets[0].hookStop).toBeDefined();
    expect(state.pendingCommit).toBeUndefined();
    // The hook's work is preserved rather than discarded or auto-committed.
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toContain("dirty");
  },
  30_000,
);

cliTest(
  "does not auto-commit or accept an unchanged resume after a dirty hook",
  async () => {
    const f = fixture();
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    // Dirty the worktree on the first successful commit only; a later resume
    // must not silently turn the leftover into a fixup.
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f "${join(f.root, "hook-dirtied-once")}" ]; then\n  touch "${join(f.root, "hook-dirtied-once")}"\n  echo dirty >> feature.txt\nfi\n`,
      { mode: 0o755 },
    );
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    const anchor = blocked.tickets[0].anchor;
    expect(anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(blocked.lastError).toContain("dirty after committing");
    expect(blocked.tickets[0].commit).toBeUndefined();
    // Resume with no explicit resolution: the hook's leftover work must not
    // become a fixup, and the ticket must not be accepted.
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = readState(runDir);
    expect(after.lastError).toContain("Unresolved hook");
    expect(after.tickets[0].anchor).toBe(anchor);
    expect(after.tickets[0].workHead).toBe(anchor);
    expect(after.tickets[0].commit).toBeUndefined();
    expect(after.tickets[0].status).toBe("blocked");
    expect(f.git("-C", after.worktree, "rev-list", "--count", `${anchor}..HEAD`)).toBe("0");
    // The hook's work is still preserved.
    expect(readFileSync(join(after.worktree, "feature.txt"), "utf8")).toContain("dirty");
  },
  30_000,
);

cliTest(
  "resumes after a dirty hook once the operator commits the preserved work",
  async () => {
    const f = fixture();
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f "${join(f.root, "hook-dirtied-once")}" ]; then\n  touch "${join(f.root, "hook-dirtied-once")}"\n  echo dirty >> feature.txt\nfi\n`,
      { mode: 0o755 },
    );
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    // The operator explicitly commits the hook's preserved work.
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "Manual resolution of hook leftovers");
    const manual = f.git("-C", blocked.worktree, "rev-parse", "HEAD");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    // Acceptance records the operator's commit; the controller adds no fixup.
    expect(finished.tickets[0].commit).toBe(manual);
    expect(finished.tickets[0].workHead).toBe(manual);
    expect(finished.tickets[0].repairCommits).toBeUndefined();
  },
  30_000,
);

cliTest(
  "preserves staged work and stops for recovery when commit signing is misconfigured",
  async () => {
    const f = fixture("blocked-review");
    f.git("config", "commit.gpgsign", "true");
    f.git("config", "gpg.program", join(f.root, "missing-gpg"));
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toMatch(/gpg failed to sign|failed to write commit object/);
    expect(state.tickets[0].anchor).toBeUndefined();
    // Hooks were never bypassed and the staged work survives the rejection.
    expect(f.git("-C", state.worktree, "diff", "--cached", "--name-only")).toContain("feature.txt");
    // Repairing the configuration lets a later resume commit the same work.
    f.git("config", "--unset", "commit.gpgsign");
    f.git("config", "--unset", "gpg.program");
    const resumed = await f.run("resume", runDir);
    // The blocked review still stops the run, but the commit is recovered.
    expect(resumed.status).toBe(1);
    const after = readState(runDir);
    expect(after.tickets[0].anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(after.tickets[0].repairs).toBe(0);
    expect(after.tickets[0].commit).toBeUndefined();
  },
  30_000,
);

cliTest(
  "stops for recovery when SSH commit signing is unconfigured",
  async () => {
    const f = fixture("blocked-review");
    f.git("config", "commit.gpgsign", "true");
    f.git("config", "gpg.format", "ssh");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toContain("signingkey");
    // A signing configuration error is not a proven code defect: no repair round
    // is spent and the staged work survives for operator recovery.
    expect(state.tickets[0].repairs).toBe(0);
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(f.git("-C", state.worktree, "diff", "--cached", "--name-only")).toContain("feature.txt");
  },
  30_000,
);

cliTest(
  "preserves a pending commit when a post-commit hook exceeds the Git deadline",
  async () => {
    const f = fixture("pass");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "post-commit"), `#!/bin/sh\nsleep 5\n`, { mode: 0o755 });
    const settingsDir = join(f.root, "deadline-settings");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "loop-settings.json");
    writeFileSync(settingsPath, JSON.stringify({ deadlines: { gitMs: 500 } }), "utf8");
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
      "--settings",
      settingsPath,
    );
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    // Git created the commit, but the post-commit hook outlasted the deadline:
    // the intent is retained for reconciliation instead of being discarded.
    expect(state.pendingCommit).toBeDefined();
    expect(state.tickets[0].anchor).toBeUndefined();
    const head = f.git("-C", state.worktree, "rev-parse", "HEAD");
    expect(head).not.toBe(state.baseSha);
    expect(f.git("-C", state.worktree, "log", "-1", "--format=%s")).toBe("loop: #11 Ticket 11");
    // Resume reconciles the recorded operation instead of duplicating it.
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.pendingCommit).toBeUndefined();
    expect(finished.tickets[0].anchor).toBe(head);
    expect(f.git("-C", finished.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe(
      "1",
    );
  },
  30_000,
);

cliTest(
  "reconciles a dirty post-commit crash without duplicating or auto-committing",
  async () => {
    const f = fixture("pass");
    const { runDir, worktree, state } = await startThenKillAfterCommit(
      f,
      "echo dirty >> feature.txt\n",
    );
    expect(state.pendingCommit).toBeDefined();
    const head = f.git("-C", worktree, "rev-parse", "HEAD");
    expect(head).not.toBe(state.baseSha);
    rmSync(join(runDir, "run.lock"), { force: true });
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = readState(runDir);
    // The recovered commit is recorded once and its dirty hook leftovers are
    // preserved under an unresolved hook stop rather than committed as a fixup.
    expect(after.pendingCommit).toBeUndefined();
    expect(after.tickets[0].anchor).toBe(head);
    expect(after.tickets[0].hookStop).toBeDefined();
    expect(after.lastError).toContain("left uncommitted changes");
    expect(readFileSync(join(after.worktree, "feature.txt"), "utf8")).toContain("dirty");
    expect(f.git("-C", after.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("1");
    // An unchanged later resume keeps the leftovers refused instead of turning
    // them into a fixup, even though the commit is already recorded.
    const again = await f.run("resume", runDir);
    expect(again.status).toBe(1);
    const stillBlocked = readState(runDir);
    expect(stillBlocked.lastError).toContain("Unresolved hook");
    expect(
      f.git("-C", stillBlocked.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`),
    ).toBe("1");
  },
  30_000,
);

cliTest(
  "records a bounded combined commit log for a rejected hook",
  async () => {
    const f = fixture("hook-repair");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f hook-fixed.txt ]; then\n  echo "feature.txt:1:1 error: STDOUT_DIAGNOSTIC"\n  echo "feature.txt:1:2 error: STDERR_DIAGNOSTIC" >&2\n  exit 1\nfi\n`,
      { mode: 0o755 },
    );
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const repair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    // The repairer gets both the combined diagnostic and a durable log path.
    expect(repair.prompt).toContain("STDOUT_DIAGNOSTIC");
    expect(repair.prompt).toContain("STDERR_DIAGNOSTIC");
    const logPath = repair.prompt.match(/Log: (.+)/)![1].trim();
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("STDERR_DIAGNOSTIC");
  },
  30_000,
);

cliTest.each([
  ["source diagnostic", "feature.txt:1:1 error: Unexpected token"],
  ["TypeScript diagnostic", "feature.ts(1,1): error TS2322: Type mismatch"],
  ["Biome lint diagnostic", "feature.ts:1:7 lint/correctness/noUnusedVariables  FIXABLE"],
  ["Biome formatting diagnostic", "Formatter would have printed the following content:"],
  ["test assertion", "AssertionError: expected 1 to be 2"],
  ["Rust diagnostic", "error[E0308]: mismatched types"],
])(
  "returns an actionable hook failure to the last editing session and spends a repair round (%s)",
  async (_label, diagnostic) => {
    const f = fixture("hook-repair");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f hook-fixed.txt ]; then\n  echo "${diagnostic}" >&2\n  exit 1\nfi\n`,
      { mode: 0o755 },
    );
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const ticket = state.tickets[0];
    expect(ticket.status).toBe("accepted");
    expect(ticket.repairs).toBe(1);
    const workers = readWorkers(f.root).filter((worker) => worker.name.includes("#11 "));
    const implement = workers.find((worker) => worker.name.includes("implement"))!;
    const repair = workers.find((worker) => worker.name.includes("repair"))!;
    // The hook defect returned to the last editing conversation, not a fresh one.
    expect(repair.session).toBe(implement.session);
    expect(repair.prompt).toContain("Commit hooks rejected the work");
    expect(repair.prompt).toContain(diagnostic);
    // Hooks were never bypassed: the anchor commit contains the repair.
    expect(f.git("-C", state.worktree, "show", `${ticket.anchor}:hook-fixed.txt`)).toContain(
      "fixed",
    );
    // A fresh independent reviewer assessed the repaired artifact.
    const review = workers.find((worker) => worker.name.includes("review"))!;
    expect(review.session).not.toBe(implement.session);
    expect(ticket.review).toMatchObject({ outcome: "pass" });
  },
  30_000,
);

cliTest(
  "returns a failed recheck of a clean hook mutation to the last editing session",
  async () => {
    const f = fixture("hook-mutation-repair");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    // A formatter-style hook appends to the staged file and commits it once.
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f "${join(f.root, "hook-mutated-once")}" ]; then\n  touch "${join(f.root, "hook-mutated-once")}"\n  echo mutated >> feature.txt\n  git add feature.txt\nfi\n`,
      { mode: 0o755 },
    );
    // Passes before the hook, fails on the hook-mutated committed tree, then
    // passes once the repairer removes the injected content.
    const check = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs');process.exit(fs.readFileSync('feature.txt','utf8').includes('mutated')?1:0)"`;
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const ticket = state.tickets[0];
    expect(ticket.status).toBe("accepted");
    // The failed recheck spent exactly one repair round and returned to the editor.
    expect(ticket.repairs).toBe(1);
    const workers = readWorkers(f.root).filter((worker) => worker.name.includes("#11 "));
    const implement = workers.find((worker) => worker.name.includes("implement"))!;
    const repair = workers.find((worker) => worker.name.includes("repair"))!;
    expect(repair.session).toBe(implement.session);
    expect(repair.prompt).toContain(
      "Checks failed after a successful hook changed the committed tree",
    );
    // A fresh independent reviewer assessed the repaired artifact.
    const review = workers.find((worker) => worker.name.includes("review"))!;
    expect(review.session).not.toBe(implement.session);
    expect(ticket.review).toMatchObject({ outcome: "pass" });
    // The hook mutation is gone from the accepted tree.
    expect(f.git("-C", state.worktree, "show", `${ticket.commit}:feature.txt`)).not.toContain(
      "mutated",
    );
  },
  30_000,
);

cliTest.each([
  ["a missing tool", `echo "pnpm: command not found" >&2`],
  ["a missing hook interpreter", "", "/nonexistent/issue-loop-hook-interpreter"],
  ["a missing linker", "echo 'error: linker `cc` not found' >&2"],
  [
    "a missing hook interpreter diagnostic",
    `echo "error: cannot run .git/hooks/pre-commit: No such file or directory" >&2`,
  ],
  [
    "a missing tool after a source diagnostic",
    `echo "feature.ts:1:1 error: Unexpected token"; echo "pnpm: command not found" >&2`,
  ],
  [
    "a missing tool before long compiler output",
    `echo "pnpm: command not found" >&2
    i=0
    while [ "$i" -lt 100 ]; do
      echo "feature.ts:1:1 error: Unexpected token" >&2
      i=$((i+1))
    done`,
  ],
  [
    "a missing shell command after a source diagnostic",
    `echo "feature.ts:1:1 error: Unexpected token"; echo "pre-commit: 1: pnpm: not found" >&2`,
  ],
  [
    "a runner startup failure",
    `echo "FAIL tests/example.test.ts"; echo "Error: Cannot find package 'vitest'" >&2`,
  ],
  ["an unclassified error count", `echo "Found 1 error" >&2`],
  ["an unclassified failure symbol", `echo "✖ Hook setup failed" >&2`],
  ["an unrecognized diagnostic", `echo "STDOUT_DIAGNOSTIC"; echo "STDERR_DIAGNOSTIC" >&2`],
])(
  "stops for recovery on %s without spending a repair round",
  async (_label, diagnostic, interpreter = "/bin/sh") => {
    const f = fixture("hook-repair");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), `#!${interpreter}\n${diagnostic}\nexit 1\n`, {
      mode: 0o755,
    });
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    // Unclassified hook output is not proof of a code defect: no repair worker
    // launched, no repair round consumed, and the staged work is preserved.
    expect(state.status).toBe("blocked");
    expect(state.lastError).toContain("Git hooks rejected the work commit");
    expect(state.tickets[0].repairs).toBe(0);
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(readWorkers(f.root).some((worker) => worker.name.includes("repair"))).toBe(false);
    expect(f.git("-C", state.worktree, "rev-parse", "HEAD")).toBe(state.tickets[0].baseline);
    expect(f.git("-C", state.worktree, "diff", "--cached", "--name-only")).toContain("feature.txt");
  },
  30_000,
);

cliTest(
  "records stable run and step trailers on feature and fixup commits",
  async () => {
    const f = fixture("fixup");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    const ticket = state.tickets[0];
    const show = (format: string, sha: string) =>
      f.git("-C", state.worktree, "log", "-1", format, sha);
    // A readable feature subject with a stable run/step trailer.
    expect(show("--format=%s", ticket.anchor)).toBe("loop: #11 Ticket 11");
    const anchorBody = show("--format=%B", ticket.anchor);
    expect(anchorBody).toContain(`Loop-Run: ${state.name}`);
    expect(anchorBody).toContain("Loop-Step: #11-implement-1");
    // Later repairs are standard fixups targeting the anchor, same trailers.
    const fixup = ticket.repairCommits[0];
    expect(show("--format=%s", fixup)).toBe("fixup! loop: #11 Ticket 11");
    const fixupBody = show("--format=%B", fixup);
    expect(fixupBody).toContain(`Loop-Run: ${state.name}`);
    expect(fixupBody).toContain("Loop-Step: #11-repair-1");
  },
  30_000,
);

cliTest(
  "recovers a crash after Git created the commit without duplicating it",
  async () => {
    const f = fixture("pass");
    const { runDir, worktree, state } = await startThenKillAfterCommit(f);
    // The intent was persisted before Git; the commit was never recorded.
    expect(state.pendingCommit).toBeDefined();
    expect(state.tickets[0].anchor).toBeUndefined();
    const head = f.git("-C", worktree, "rev-parse", "HEAD");
    expect(head).not.toBe(state.baseSha);
    expect(f.git("-C", worktree, "log", "-1", "--format=%s")).toBe("loop: #11 Ticket 11");
    // The controller was killed; remove its stale lock as documented.
    rmSync(join(runDir, "run.lock"), { force: true });
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.pendingCommit).toBeUndefined();
    expect(finished.tickets[0].anchor).toBe(head);
    // Recovery recorded the existing commit instead of making another.
    expect(f.git("-C", finished.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe(
      "1",
    );
  },
  30_000,
);

cliTest(
  "blocks on an ambiguous pending commit with diagnostics and preserved work",
  async () => {
    const f = fixture("pass");
    const { runDir, worktree } = await startThenKillAfterCommit(f);
    // The operator rewrites the unrecorded commit so it no longer proves the operation.
    f.git("-C", worktree, "commit", "--amend", "-m", "operator overwrite");
    rmSync(join(runDir, "run.lock"), { force: true });
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = readState(runDir);
    expect(after.lastError).toContain("Unverified pending commit");
    expect(after.tickets[0].anchor).toBeUndefined();
    expect(after.tickets[0].commit).toBeUndefined();
    // The operator's work is preserved rather than overwritten or duplicated.
    expect(f.git("-C", after.worktree, "log", "-1", "--format=%s")).toBe("operator overwrite");
  },
  30_000,
);

cliTest(
  "refuses a verdict when the read-only review edits the artifact",
  async () => {
    const f = fixture("review-edit");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toContain("changed the worktree");
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[0].review).toBeUndefined();
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toContain("tampered");
  },
  30_000,
);

cliTest(
  "keeps failed-check work uncommitted and preserves it for repair",
  async () => {
    const f = fixture();
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "false");
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(state.tickets[0].commit).toBeUndefined();
    expect(f.git("-C", state.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("0");
    // The worker's changes survive outside a commit.
    expect(existsSync(join(state.worktree, "feature.txt"))).toBe(true);
  },
  30_000,
);
