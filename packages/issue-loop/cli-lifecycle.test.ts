// Full loop, PR creation, and advisory-review outcomes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  cliTest,
  fixture,
  readState,
  readSummary,
  readWorkers,
  runDirFrom,
} from "./cli-fixture.ts";

cliTest(
  "accepts dependent tickets on one branch and opens one final PR without closing issues",
  async () => {
    const f = fixture();
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("done");
    expect(state.tickets.map((ticket: { status: string }) => ticket.status)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(f.git("branch", "--show-current")).toBe("main");
    const summary = readSummary(runDir);
    expect(summary).toContain("https://github.com/test/project/pull/99");
    const workers = readFileSync(join(f.root, "workers.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(workers.every((worker) => worker.name.startsWith(state.name))).toBe(true);
    expect(new Set(workers.map((worker) => worker.session)).size).toBe(workers.length);
    const reviews = workers.filter((worker) => worker.name.includes("review"));
    expect(reviews.length).toBeGreaterThanOrEqual(3);
    expect(reviews.every((worker) => worker.args.includes("read,grep,find,ls"))).toBe(true);
    expect(workers.every((worker) => worker.args.includes("--no-skills"))).toBe(true);
    // RPC mode with ambient extensions disabled for every worker.
    expect(
      workers.every(
        (worker) =>
          worker.args.includes("--mode") &&
          worker.args[worker.args.indexOf("--mode") + 1] === "rpc" &&
          worker.args.includes("--no-extensions"),
      ),
    ).toBe(true);
    expect(reviews.every((worker) => worker.prompt.includes('"findings"'))).toBe(true);
    // Blessed defaults: implementers get the curated trio, reviewers get none.
    const implementers = workers.filter((worker) => worker.name.includes("implement"));
    expect(implementers.length).toBeGreaterThan(0);
    expect(implementers.every((worker) => worker.prompt.includes('"outcome"'))).toBe(true);
    expect(
      implementers.every(
        (worker) =>
          worker.args.includes("--skill") &&
          worker.args.some((arg: string) => arg.endsWith(join("skills", "tdd"))) &&
          worker.args.some((arg: string) => arg.endsWith(join("skills", "deslop"))),
      ),
    ).toBe(true);
    expect(reviews.every((worker) => !worker.args.includes("--skill"))).toBe(true);
    expect(existsSync(join(runDir, "skills", "tdd", "SKILL.md"))).toBe(true);
    expect(existsSync(join(runDir, "skills", "diagnosing-bugs", "SKILL.md"))).toBe(true);
    const prArgs = JSON.parse(readFileSync(join(f.root, "pr.json"), "utf8"));
    const baseIndex = prArgs.indexOf("--base");
    expect(prArgs.slice(baseIndex, baseIndex + 2)).toEqual(["--base", "main"]);
    // A passing final review with no findings is still posted as an advisory
    // comment with its verdict, summary, and reviewed artifact.
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Final whole-artifact review");
    expect(comments[0].body).toContain("(pass)");
    expect(comments[0].body).toContain("Review passed.");
    expect(comments[0].body).toContain(state.review.head);
    expect(comments[0].body).toContain(state.review.tree);
  },
  30_000,
);

cliTest(
  "keeps passing review bodies for tickets and parent without starting repairs",
  async () => {
    const f = fixture("pass-notes");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("done");
    expect(state.tickets.every((ticket: { repairs: number }) => ticket.repairs === 0)).toBe(true);
    expect(
      state.tickets.every(
        (ticket: { review: { outcome: string; findings: { description: string }[] } }) =>
          ticket.review.outcome === "pass" &&
          ticket.review.findings[0]?.description === "[Spec][Minor] Ticket cleanup",
      ),
    ).toBe(true);
    expect(state.review).toMatchObject({
      outcome: "pass",
      findings: [{ description: "[Standards][Minor] Parent cleanup" }],
    });
    const summary = readSummary(runDir);
    expect(summary).toContain("Review observations");
    expect(summary).toContain("may have been resolved");
    expect(summary).toContain("[Spec][Minor] Ticket cleanup");
    expect(summary).toContain("[Standards][Minor] Parent cleanup");
    expect(summary).toContain(state.review.head);
    expect(summary).toContain(state.review.tree);
    expect(state.review.head).toBe(state.head);
    expect(state.review.tree).toBe(f.git("-C", state.worktree, "rev-parse", "HEAD^{tree}"));
    // The committed feature anchor is the exact reviewed artifact, then accepted.
    expect(state.tickets[0].review.head).toBe(state.tickets[0].anchor);
    expect(state.tickets[0].review.head).toBe(state.tickets[0].commit);
    expect(state.tickets[0].workHead).toBe(state.tickets[0].commit);
    for (const ticket of state.tickets) {
      expect(ticket.review.head).toMatch(/^[a-f0-9]{40}$/);
      expect(ticket.review.tree).toBe(f.git("rev-parse", `${ticket.commit}^{tree}`));
      // Controller-assigned finding identity and artifact reference.
      expect(ticket.review.findings[0]).toMatchObject({
        id: 1,
        artifact: { head: ticket.review.head, tree: ticket.review.tree },
      });
    }
    const pr = readFileSync(join(runDir, "pr.md"), "utf8");
    expect(pr).not.toContain("[Spec][Minor] Ticket cleanup");
    expect(pr).not.toContain("[Standards][Minor] Parent cleanup");
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("[Spec][Minor] Ticket cleanup");
    expect(comments[0].body).toContain("[Standards][Minor] Parent cleanup");
    expect(comments[0].body).toContain(state.review.tree);
  },
  30_000,
);

cliTest(
  "creates the PR before the advisory whole-artifact review without parent repairs",
  async () => {
    const f = fixture("parent-reject");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("done");
    // The final review is advisory: a material verdict is recorded, not repaired.
    expect(state.review).toMatchObject({ outcome: "changes_requested" });
    expect(state.advisoryWarning).toBeUndefined();
    // The PR existed before the review ran, and no parent editing was authorized.
    expect(readFileSync(join(f.root, "parent-review-order.txt"), "utf8").trim()).toBe("after-pr");
    const workers = readWorkers(f.root);
    expect(
      workers.some(
        (worker) =>
          worker.name.includes("parent implement") || worker.name.includes("parent repair"),
      ),
    ).toBe(false);
    // The advisory comment carries the finding, the reviewed SHA, and its outcome.
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    const advisory = comments.find((comment: { body: string }) =>
      comment.body.includes("Final whole-artifact review"),
    )!;
    expect(advisory.body).toContain("Missing acceptance criterion");
    expect(advisory.body).toContain(state.review.head);
    expect(advisory.body).toContain("changes_requested");
    expect(state.advisoryCommentId).toBeGreaterThan(0);
    // Child history is retained: no squash and no parent commit.
    const subjects = f.git("-C", state.worktree, "log", "--format=%s", `${state.baseSha}..HEAD`);
    expect(subjects).toContain("loop: #11 Ticket 11");
    expect(subjects).not.toContain("loop: parent");
  },
  30_000,
);

cliTest(
  "finishes with a visible warning when the advisory whole-artifact review is unavailable",
  async () => {
    const f = fixture("fail-parent-review");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("done");
    // A failed advisory review never claims a pass and never traps the PR.
    expect(state.review).toBeUndefined();
    expect(state.advisoryWarning).toContain("unavailable");
    expect(state.pr).toBe("https://github.com/test/project/pull/99");
    expect(existsSync(join(f.root, "pr.json"))).toBe(true);
    const summary = readSummary(runDir);
    expect(summary).toContain("unavailable");
    expect(result.stderr).toContain("Warning");
  },
  30_000,
);

cliTest(
  "gates PR creation on required checks for the publication artifact",
  async () => {
    const f = fixture();
    const check = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs');const p=process.env.FIXTURE_ROOT+'/final-check-count';const n=(fs.existsSync(p)?+fs.readFileSync(p):0)+1;fs.writeFileSync(p,String(n));process.exit(n>=3?1:0)"`;
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.status).toBe("blocked");
    expect(state.phase).toBe("final");
    expect(state.lastError).toContain("Required checks failed for the publication artifact");
    expect(readFileSync(join(f.root, "final-check-count"), "utf8")).toBe("3");
    // No PR and no advisory review exist for an unverified artifact.
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
    expect(state.review).toBeUndefined();
    expect(state.tickets.every((ticket: { status: string }) => ticket.status === "accepted")).toBe(
      true,
    );
  },
  30_000,
);

cliTest(
  "persists a blocked review body before stopping",
  async () => {
    const f = fixture("blocked-review");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.tickets[0].review).toMatchObject({
      outcome: "blocked",
      summary: "Cannot assess required behavior",
    });
    expect(state.tickets[0].repairs).toBe(0);
  },
  30_000,
);

cliTest(
  "preserves a first-ticket failure, then reviews manual fixes on resume without repeating implementation",
  async () => {
    const f = fixture("fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.status).toBe("blocked");
    expect(blocked.tickets.map((ticket: { status: string }) => ticket.status)).toEqual([
      "blocked",
      "pending",
    ]);
    expect(readSummary(runDir)).toContain("Provider unavailable");
    expect(blocked.sessions[0].name).toContain("#11 implement · attempt 1");
    // An unsuccessful exit persists its elapsed runtime for resume.
    expect(typeof blocked.sessions[0].consumedMs).toBe("number");
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.name).toBe(blocked.name);
    expect(
      finished.sessions.filter((session: { name: string }) =>
        session.name.includes("#11 implement"),
      ),
    ).toHaveLength(1);
    expect(finished.sessions[1].name).toContain("#11 review · attempt 1");
    expect(readSummary(runDir)).toContain("pi --session");
  },
  30_000,
);
