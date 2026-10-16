// PR publication and observations-comment reconciliation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest, fixture, readState, runDirFrom } from "./cli-fixture.ts";

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
  "updates the same observations comment after an interrupted post",
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
    expect(state.phase).toBe("publish");
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
    expect(comments[1].body).toContain("[P3] Ticket cleanup");
    expect(comments[1].body).toContain(finished.tickets[1].review.tree);
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
    expect(posted.observationsCommentAuthor).toBe("loop-author");
    expect(posted.observationsCommentId).toBeGreaterThan(0);
    // Simulate a crash after the comment state was saved but before the run was
    // marked done.
    const crashed = { ...posted, status: "blocked", phase: "publish" };
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
      JSON.stringify({ ...posted, status: "blocked", phase: "publish" }),
    );
    writeFileSync(join(f.root, "pr-comments.json"), "[]");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const state = readState(runDir);
    expect(state.lastError).toContain(
      `Recorded review observations comment ${posted.observationsCommentId}`,
    );
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
    expect(blocked.observationsCommentAuthor).toBe("loop-author");
    expect(blocked.observationsCommentId).toBeUndefined();
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
