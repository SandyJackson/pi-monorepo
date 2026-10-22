// Full loop, PR description, and draft PR creation.
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
import { DEFAULT_REVIEW_TOOLS, DESCRIBE_TOOLS } from "./settings.ts";

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
    expect(reviews).toHaveLength(2);
    expect(reviews.every((worker) => worker.args.includes(DEFAULT_REVIEW_TOOLS.join(",")))).toBe(
      true,
    );
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
    // One PR-description worker, with the pr skill and no editing tools.
    const describers = workers.filter((worker) => worker.name.includes("parent describe"));
    expect(describers).toHaveLength(1);
    expect(describers[0].args).toContain(DESCRIBE_TOOLS.join(","));
    expect(describers[0].args.some((arg: string) => arg.endsWith(join("skills", "pr")))).toBe(true);
    expect(describers[0].prompt).toContain('"body"');
    expect(existsSync(join(runDir, "skills", "pr", "SKILL.md"))).toBe(true);
    const prArgs = JSON.parse(readFileSync(join(f.root, "pr.json"), "utf8"));
    const baseIndex = prArgs.indexOf("--base");
    expect(prArgs.slice(baseIndex, baseIndex + 2)).toEqual(["--base", "main"]);
    expect(prArgs).toContain("--draft");
    // The worker's body leads; the controller owns the review note and closing lines.
    const pr = readFileSync(join(runDir, "pr.md"), "utf8");
    expect(pr.startsWith("## Summary\n\nAdds feature.txt.")).toBe(true);
    expect(pr).toContain("`/skill:code-review mode=full`");
    expect(pr).toContain("Closes #10\nCloses #11\nCloses #12");
    expect(pr).not.toContain("[!NOTE]");
    // No passing review left an observation, so no comment is posted.
    expect(existsSync(join(f.root, "pr-comments.json"))).toBe(false);
  },
  30_000,
);

cliTest(
  "keeps passing ticket review observations without starting repairs",
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
          ticket.review.findings[0]?.description === "[P3] Ticket cleanup",
      ),
    ).toBe(true);
    const summary = readSummary(runDir);
    expect(summary).toContain("Review observations");
    expect(summary).toContain("may have been resolved");
    expect(summary).toContain("[P3][correctness-requirements] review: [P3] Ticket cleanup");
    expect(summary).toContain(state.tickets[1].review.head);
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
    expect(pr).not.toContain("[P3] Ticket cleanup");
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("[P3] Ticket cleanup");
    expect(comments[0].body).toContain(state.tickets[1].review.tree);
    expect(state.observationsCommentId).toBeGreaterThan(0);
    // Child history is retained: no squash and no parent commit.
    const subjects = f.git("-C", state.worktree, "log", "--format=%s", `${state.baseSha}..HEAD`);
    expect(subjects).toContain("loop: #11 Ticket 11");
    expect(subjects).not.toContain("loop: parent");
  },
  30_000,
);

cliTest(
  "rewrites closing keywords in the worker's PR description and notes it",
  async () => {
    const f = fixture();
    f.env.FIXTURE_PR_BODY = [
      "## Summary",
      "",
      "Fixes #12345, closes: other/repo#777 and Resolved https://github.com/test/project/issues/5.",
      "Mentions #11 and enclosed #4 without closing them.",
    ].join("\n");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const pr = readFileSync(join(runDirFrom(result.stdout), "pr.md"), "utf8");
    const [generated, controller] = pr.split("\n---\n");
    expect(generated).toContain(
      "Refs #12345, Refs other/repo#777 and Refs https://github.com/test/project/issues/5.",
    );
    expect(generated).toContain("Mentions #11 and enclosed #4 without closing them.");
    expect(generated).not.toMatch(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+\S*(?:#\d|\/issues\/)/i,
    );
    expect(generated).toContain("rewrote 3 closing keywords");
    expect(controller).toContain("Closes #10");
  },
  30_000,
);

cliTest(
  "stops before publication when the PR description is blocked",
  async () => {
    const f = fixture("describe-blocked");
    const result = await f.start();
    expect(result.status).toBe(1);
    const state = readState(runDirFrom(result.stdout));
    expect(state.status).toBe("blocked");
    expect(state.phase).toBe("describe");
    expect(state.lastError).toContain("The patch is unreadable.");
    expect(state.prDescription).toBeUndefined();
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
    // Resume describes again; accepted work is not repeated.
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", state.runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(state.runDir);
    expect(finished.status).toBe("done");
    expect(finished.prDescription?.head).toBe(finished.head);
    expect(readWorkers(f.root).filter((worker) => worker.name.includes("implement"))).toHaveLength(
      2,
    );
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
    // No description and no PR exist for an unverified artifact.
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
    expect(state.prDescription).toBeUndefined();
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
