#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gh, githubHostFromOrigin, snapshot } from "./github.ts";
import { git, originUrl } from "./process.ts";
import { execute } from "./runner.ts";
import { defaultLoopSettings, loadLoopSettings } from "./settings.ts";
import { load, RUN_STATE_VERSION, type RunState, save } from "./state.ts";

const usage = `Usage:
  node packages/issue-loop/run.mjs start --repo PATH --issue NUMBER --check COMMAND [--setup COMMAND] [--timeout SECONDS] [--settings PATH]
  node packages/issue-loop/run.mjs resume RUN_DIRECTORY

Requires Node 22.18+ or 24+, Git, authenticated gh and Pi. macOS/Linux only.
Starts from origin's default branch. Uses direct open GitHub child issues and native dependencies.
--setup runs once in the new worktree; --check runs after every change and before final publication.
--timeout limits each worker/setup/check invocation (default 1800 seconds).
--settings points at an optional JSON file customizing worker models, tool allowlists,
role guidance and a shared system-prompt addition (see Customizing workers below).

This command trusts the project's Pi resources and runs setup/check commands with your privileges.
It commits accepted work, pushes only its feature branch and opens one PR. It never merges.
Issues stay open until a human merges the final PR. Workers retain your Pi extensions and use explicit names.
Resume preserves manual fixes and checks/reviews the blocked ticket before implementing more changes.
State, summary and sessions are kept in ../.pi-issue-loops/<run>/ beside the source repository.
`;

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === "--help" || action === "-h") {
    console.log(usage);
    return;
  }
  if (process.platform === "win32")
    throw new Error("This first version supports macOS and Linux only");
  if (action === "resume") {
    if (args.length !== 1 || args[0].startsWith("-")) throw new Error(usage);
    const state = load(resolve(args[0]));
    console.log(`Run directory: ${state.runDir}`);
    await execute(state);
    return;
  }
  if (action !== "start") throw new Error(usage);
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      issue: { type: "string" },
      check: { type: "string" },
      setup: { type: "string" },
      timeout: { type: "string", default: "1800" },
      settings: { type: "string" },
    },
  });
  if (!values.repo || !values.issue || !/^[1-9]\d*$/.test(values.issue) || !values.check?.trim())
    throw new Error(usage);
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7200)
    throw new Error("--timeout must be 1 to 7200 seconds");
  // Fail fast on bad settings before creating the run; resume reuses the snapshot.
  const settings = values.settings
    ? loadLoopSettings(resolve(values.settings))
    : defaultLoopSettings();
  const repo = await git(resolve(values.repo), "rev-parse", "--show-toplevel");
  const origin = await originUrl(repo);
  const host = githubHostFromOrigin(origin);
  const repositoryUrl = origin.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  const metadata = JSON.parse(
    await gh(repo, host, "repo", "view", repositoryUrl, "--json", "nameWithOwner,defaultBranchRef"),
  ) as { nameWithOwner: string; defaultBranchRef: { name: string } };
  if (!/^[\w.-]+\/[\w.-]+$/.test(metadata.nameWithOwner) || !metadata.defaultBranchRef?.name)
    throw new Error("Cannot determine the GitHub repository and default branch");
  const baseBranch = metadata.defaultBranchRef.name;
  await git(repo, "check-ref-format", `refs/heads/${baseBranch}`);
  const { parent, tickets } = await snapshot(
    repo,
    host,
    metadata.nameWithOwner,
    Number(values.issue),
  );
  await git(repo, "fetch", "origin", `refs/heads/${baseBranch}`);
  const baseSha = await git(repo, "rev-parse", "FETCH_HEAD");
  const id = `${parent.number}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const runDir = join(dirname(repo), ".pi-issue-loops", `${basename(repo)}-${id}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const state: RunState = {
    version: RUN_STATE_VERSION,
    name: `loop/${metadata.nameWithOwner}/${id}`,
    repo,
    githubRepo: metadata.nameWithOwner,
    origin,
    runDir,
    worktree: join(runDir, "worktree"),
    branch: `loop/${id}`,
    baseBranch,
    baseSha,
    head: baseSha,
    check: values.check,
    setup: values.setup,
    timeoutMs: timeout * 1000,
    settings,
    parent,
    tickets,
    sessions: [],
    finalRepairs: 0,
    phase: "setup",
    status: "running",
  };
  save(state);
  console.log(`Run directory: ${runDir}`);
  await execute(state);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
