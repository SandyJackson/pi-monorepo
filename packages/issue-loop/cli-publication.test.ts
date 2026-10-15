// PR publication and advisory-comment reconciliation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  advanceRemote,
  advisoryComments,
  cliTest,
  fixture,
  interruptAtReady,
  readState,
  readSummary,
  readWorkers,
  runDirFrom,
} from "./cli-fixture.ts";

cliTest(
  "finds an already-created PR after publication was interrupted",
  async () => {
    const f = fixture("publish-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const state = readState(runDir);
    expect(state.phase).toBe("publish");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
    expect((await f.run("resume", runDir)).status).toBe(0);
    expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);

cliTest(
  "updates the same observations comment after an interrupted advisory post",
  async () => {
    const f = fixture("comment-create-fail");
    writeFileSync(
      join(f.root, "pr-comments.json"),
      JSON.stringify([{ id: 41, body: "Human notes", user: { login: "human" } }]),
    );
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const state = readState(runDir);
    expect(state.phase).toBe("advisory");
    expect(state.pr).toBe("https://github.com/test/project/pull/99");
    const originalPr = readFileSync(join(runDir, "pr.md"), "utf8");
    const existingComments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    const commentId = existingComments[1].id;
    existingComments[1].body = `Human introduction\n${existingComments[1].body}\nHuman follow-up`;
    const forged = { id: 43, body: existingComments[1].body, user: { login: "other-human" } };
    existingComments.push(forged);
    writeFileSync(join(f.root, "pr-comments.json"), JSON.stringify(existingComments));
    f.env.FIXTURE_MODE = "pass-notes";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(3);
    expect(comments[0]).toEqual({ id: 41, body: "Human notes", user: { login: "human" } });
    expect(comments[2]).toEqual(forged);
    expect(comments[1].id).toBe(commentId);
    expect(comments[1].body).toContain("Human introduction");
    expect(comments[1].body).toContain("Human follow-up");
    expect(comments[1].body).toContain("[Standards][Minor] Parent cleanup");
    expect(comments[1].body).toContain(finished.review.tree);
    expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
    expect(JSON.parse(readFileSync(join(f.root, "pr.json"), "utf8"))).not.toContain("edit");
    expect(originalPr).not.toContain("Ticket cleanup");
    const calls: string[][] = readFileSync(join(f.root, "gh-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toContainEqual([
      "api",
      "repos/test/project/issues/99/comments",
      "--paginate",
      "--slurp",
    ]);
    expect(calls).toContainEqual([
      "api",
      "repos/test/project/issues/99/comments",
      "--method",
      "POST",
      "--field",
      `body=@${join(runDir, "review-observations.md")}`,
    ]);
    expect(calls).toContainEqual([
      "api",
      `repos/test/project/issues/comments/${commentId}`,
      "--method",
      "PATCH",
      "--field",
      `body=@${join(runDir, "review-observations.md")}`,
    ]);
    expect((await f.run("resume", runDir)).status).toBe(0);
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);

cliTest(
  "reports a completed advisory review for its SHA after a later local edit",
  async () => {
    const f = fixture("comment-create-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.phase).toBe("advisory");
    expect(blocked.review).toBeTruthy();
    // The review was guarded while it ran; an unpushed edit afterwards does not
    // change the published SHA it describes.
    writeFileSync(join(blocked.worktree, "feature.txt"), "local follow-up\n");
    f.env.FIXTURE_MODE = "pass-notes";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.review).toEqual(blocked.review);
    expect(finished.advisoryWarning).toBeUndefined();
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    const advisory = comments.find((comment: { body: string }) =>
      comment.body.includes("Final whole-artifact review"),
    );
    expect(advisory.body).toContain(blocked.review.head);
    expect(advisory.body).toContain("[Standards][Minor] Parent cleanup");
    expect(readFileSync(join(blocked.worktree, "feature.txt"), "utf8")).toBe("local follow-up\n");
  },
  30_000,
);

cliTest(
  "keeps a coherent local review and marks it stale when only the remote branch advanced",
  async () => {
    const f = fixture("comment-create-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    const reviewedHead = blocked.review.head;
    // Another actor advances the PR branch; the run worktree stays untouched.
    const remoteHead = advanceRemote(f, blocked.branch);
    expect(remoteHead).not.toBe(reviewedHead);
    f.env.FIXTURE_MODE = "pass-notes";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    // The local review remains coherent and is reported against its reviewed SHA.
    expect(finished.review.head).toBe(reviewedHead);
    expect(finished.advisoryStale).toBe(true);
    // The warning names both the reviewed SHA and the advanced remote tip.
    expect(finished.advisoryWarning).toContain("stale");
    expect(finished.advisoryWarning).toContain(reviewedHead);
    expect(finished.advisoryWarning).toContain(remoteHead);
    expect(resumed.stderr).toContain("Final whole-artifact review is stale");
    expect(readSummary(runDir)).toContain("stale");
    // The run worktree and the remote branch stay as they were: no push, repair, or re-review.
    expect(f.git("-C", blocked.worktree, "rev-parse", "HEAD")).toBe(blocked.head);
    expect(f.git("-C", blocked.worktree, "status", "--porcelain")).toBe("");
    expect(
      f.git("--git-dir", join(f.root, "remote.git"), "rev-parse", `refs/heads/${blocked.branch}`),
    ).toBe(remoteHead);
    expect(
      readWorkers(f.root).filter((worker) => worker.name.includes("parent review")),
    ).toHaveLength(1);
    const [advisory] = advisoryComments(f.root);
    expect(advisoryComments(f.root)).toHaveLength(1);
    expect(advisory.body).toContain("**Stale:**");
    expect(advisory.body).toContain(reviewedHead);
    expect(advisory.body).toContain(blocked.review.tree);
    // A repeat resume does not duplicate the comment or create another PR.
    expect((await f.run("resume", runDir)).status).toBe(0);
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
    expect(advisoryComments(f.root)).toHaveLength(1);
  },
  30_000,
);

cliTest(
  "withdraws an advisory review interrupted before a local edit instead of reviewing the changed artifact",
  async () => {
    const f = fixture("hold-parent-review");
    const interrupted = await interruptAtReady(
      f,
      ["start", "--repo", f.repo, "--issue", "10", "--check", "true"],
      "parent-review-ready",
    );
    const runDir = runDirFrom(interrupted.stdout);
    const blocked = readState(runDir);
    expect(blocked.status).toBe("blocked");
    expect(blocked.phase).toBe("advisory");
    expect(blocked.review).toBeUndefined();
    expect(blocked.advisoryOutcome).toBeUndefined();
    // The operator changes a tracked file and adds an untracked one while the review is held.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Edited while the parent review ran\n");
    writeFileSync(join(blocked.worktree, "notes.txt"), "Untracked note\n");
    const launchesBeforeResume = readWorkers(f.root).length;
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    // The published SHA is unchanged, and the edited tree is never assessed as that SHA.
    expect(finished.head).toBe(blocked.head);
    expect(f.git("-C", blocked.worktree, "rev-parse", "HEAD")).toBe(blocked.head);
    expect(finished.review).toBeUndefined();
    expect(finished.advisoryOutcome).toBe("unavailable");
    expect(finished.advisoryWarning).toContain("worktree changed after publication");
    expect(resumed.stderr).toContain("Final whole-artifact review unavailable");
    expect(readSummary(runDir)).toContain("worktree changed after publication");
    // The local work is preserved, and resume does not launch another parent reviewer.
    expect(readFileSync(join(blocked.worktree, "feature.txt"), "utf8")).toBe(
      "Edited while the parent review ran\n",
    );
    expect(readFileSync(join(blocked.worktree, "notes.txt"), "utf8")).toBe("Untracked note\n");
    expect(readWorkers(f.root)).toHaveLength(launchesBeforeResume);
    expect(
      readWorkers(f.root).filter((worker) => worker.name.includes("parent review")),
    ).toHaveLength(1);
    // The warning is posted once, and a repeat resume neither reposts it nor reruns anything.
    expect(advisoryComments(f.root)).toHaveLength(1);
    expect(advisoryComments(f.root)[0].body).toContain(
      "Warning: Final whole-artifact review unavailable",
    );
    expect((await f.run("resume", runDir)).status).toBe(0);
    expect(advisoryComments(f.root)).toHaveLength(1);
    expect(readWorkers(f.root)).toHaveLength(launchesBeforeResume);
  },
  30_000,
);

cliTest(
  "withholds an advisory pass when the parent review changes only the index",
  async () => {
    const f = fixture("parent-review-index-mutation");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    // The loop has a feature commit above the base, so HEAD^ is a real commit to read into the index.
    expect(f.git("-C", state.worktree, "rev-parse", "--verify", "HEAD^")).toMatch(/^[0-9a-f]{40}$/);
    expect(state.status).toBe("done");
    expect(state.pr).toBe("https://github.com/test/project/pull/99");
    expect(state.review).toBeUndefined();
    expect(state.advisoryOutcome).toBe("unavailable");
    expect(state.advisoryWarning).toContain("changed the index");
    expect(result.stderr).toContain("changed the index");
    // Only the parent pass is withheld: HEAD, file contents, and the changed index remain.
    expect(f.git("-C", state.worktree, "rev-parse", "HEAD")).toBe(state.head);
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toBe("implemented\n");
    expect(f.git("-C", state.worktree, "ls-files", "feature.txt")).toBe("");
    const comments = advisoryComments(f.root);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Warning: Final whole-artifact review unavailable");
    expect(comments[0].body).not.toContain("(pass)");
  },
  30_000,
);

cliTest(
  "blocks on duplicate review-observations markers from the authenticated author",
  async () => {
    const f = fixture("comment-create-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    const authored = comments.find(
      (comment: { user: { login: string } }) => comment.user.login === "loop-author",
    );
    comments.push({ id: 77, body: authored.body, user: { login: "loop-author" } });
    writeFileSync(join(f.root, "pr-comments.json"), JSON.stringify(comments));
    f.env.FIXTURE_MODE = "pass-notes";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const state = readState(runDir);
    expect(state.lastError).toContain("Ambiguous or invalid review observations comment");
    // The ambiguous marker is never reconciled by creating a third comment.
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);

cliTest(
  "blocks on ambiguous existing PRs instead of creating another",
  async () => {
    const f = fixture("pr-ambiguous");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = runDirFrom(result.stdout);
    const state = readState(runDir);
    expect(state.lastError).toContain("Ambiguous existing PRs");
    expect(state.pr).toBeUndefined();
    expect(existsSync(join(f.root, "pr-created.txt"))).toBe(false);
  },
  30_000,
);

cliTest(
  "keeps the comment owner after a successful post so an account change cannot duplicate it",
  async () => {
    const f = fixture("pass-notes");
    const first = await f.start();
    expect(first.status, first.stderr).toBe(0);
    const runDir = runDirFrom(first.stdout);
    const posted = readState(runDir);
    expect(posted.advisoryCommentAuthor).toBe("loop-author");
    expect(posted.advisoryCommentId).toBeGreaterThan(0);
    // Simulate a crash after the comment state was saved but before the run was
    // marked done.
    const crashed = { ...posted, status: "blocked", phase: "advisory" };
    writeFileSync(join(runDir, "state.json"), JSON.stringify(crashed));
    const before = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    f.env.FIXTURE_GH_LOGIN = "other-author";
    const otherAccount = await f.run("resume", runDir);
    expect(otherAccount.status).toBe(1);
    const blocked = readState(runDir);
    expect(blocked.lastError).toContain("owned by loop-author");
    expect(blocked.lastError).toContain("other-author");
    expect(JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"))).toEqual(before);
    // The original account updates the recorded comment instead of posting again.
    delete f.env.FIXTURE_GH_LOGIN;
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);

cliTest(
  "blocks instead of posting again when the recorded comment is missing",
  async () => {
    const f = fixture("pass-notes");
    const first = await f.start();
    expect(first.status, first.stderr).toBe(0);
    const runDir = runDirFrom(first.stdout);
    const posted = readState(runDir);
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({ ...posted, status: "blocked", phase: "advisory" }),
    );
    writeFileSync(join(f.root, "pr-comments.json"), "[]");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const state = readState(runDir);
    expect(state.lastError).toContain(
      `Recorded review observations comment ${posted.advisoryCommentId}`,
    );
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);

cliTest(
  "resumes only the warning after an unavailable advisory review and failed warning publication",
  async () => {
    const f = fixture("fail-parent-review-comment-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    expect(blocked.phase).toBe("advisory");
    expect(blocked.review).toBeUndefined();
    expect(blocked.advisoryOutcome).toBe("unavailable");
    const reviewers = readWorkers(f.root).filter((worker) =>
      worker.name.includes("parent review"),
    ).length;
    // A provider that would now pass must not be asked for a fresh review: the
    // terminal outcome stands and resume only republishes the recorded warning.
    f.env.FIXTURE_MODE = "pass-notes";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = readState(runDir);
    expect(finished.status).toBe("done");
    expect(finished.review).toBeUndefined();
    expect(
      readWorkers(f.root).filter((worker) => worker.name.includes("parent review")),
    ).toHaveLength(reviewers);
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    const advisory = comments.find((comment: { body: string }) =>
      comment.body.includes("Warning:"),
    );
    expect(advisory.body).toContain("unavailable");
    expect(advisory.body).not.toContain("Parent cleanup");
    expect((await f.run("resume", runDir)).status).toBe(0);
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);

cliTest(
  "blocks instead of duplicating when the authenticated author changed after an interrupted comment post",
  async () => {
    const f = fixture("comment-create-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = runDirFrom(first.stdout);
    const blocked = readState(runDir);
    // The owner is persisted before the create, even though its id never was.
    expect(blocked.advisoryCommentAuthor).toBe("loop-author");
    expect(blocked.advisoryCommentId).toBeUndefined();
    const before = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    f.env.FIXTURE_MODE = "pass-notes";
    f.env.FIXTURE_GH_LOGIN = "other-author";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const state = readState(runDir);
    expect(state.lastError).toContain("loop-author");
    expect(state.lastError).toContain("other-author");
    expect(JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"))).toEqual(before);
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);
