import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { REPOSITORY_GIT_ENV } from "./test-git-env.ts";

it("clears every repository-local variable Git knows about", () => {
  const known = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  expect(REPOSITORY_GIT_ENV).toEqual(expect.arrayContaining(known));
});

it("runs tests without inheriting a hook's repository", () => {
  for (const name of REPOSITORY_GIT_ENV) expect(process.env[name]).toBeUndefined();
});
