#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gh, githubHostFromOrigin, snapshot } from "./github.ts";
import { assertSupportedPi } from "./pi-version.ts";
import { type CommandContext, git, originUrl } from "./process.ts";
import { execute } from "./runner.ts";
import {
  defaultLoopSettings,
  loadLoopSettings,
  materializeLoopSkills,
  validateLoopSkills,
} from "./settings.ts";
import { load, RUN_STATE_VERSION, type RunState, save } from "./state.ts";

const usage = `Usage:
  node packages/issue-loop/run.mjs start --repo PATH --issue NUMBER --check COMMAND [--base BRANCH] [--setup COMMAND] [--timeout SECONDS] [--settings PATH]
  node packages/issue-loop/run.mjs resume RUN_DIRECTORY

Requires Node 22.18+ or 24+, Git, authenticated gh and Pi 0.99.1 or newer. macOS/Linux only.
Starts from origin's default branch, or --base BRANCH fetched from origin. The PR targets that branch.
Uses direct open GitHub child issues and native dependencies.
--setup runs once in the new worktree; --check runs after every change and before final publication.
--timeout overrides the setup and check command deadlines (300 to 7200 seconds; default 3600).
Worker supervision uses the watchdog policy in the settings snapshot.
--settings points at an optional JSON file customizing worker models, tool allowlists,
role guidance, per-role loop skills, repair rounds, watchdog policy, controller
recovery policy, controller command deadlines, and a shared system-prompt addition
(see Customizing workers below). Workers always start with --no-skills and --no-extensions;
only curated loop skills named in the settings file are loaded.

This command trusts the project's Pi resources and runs setup/check commands with your privileges.
It commits accepted work, pushes only its feature branch and opens one PR. It never merges.
Issues stay open until a human merges the final PR. Workers use explicit names and load no ambient extensions.
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
  await assertSupportedPi();
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
      base: { type: "string" },
      issue: { type: "string" },
      check: { type: "string" },
      setup: { type: "string" },
      timeout: { type: "string" },
      settings: { type: "string" },
    },
  });
  if (!values.repo || !values.issue || !/^[1-9]\d*$/.test(values.issue) || !values.check?.trim())
    throw new Error(usage);
  const timeout = values.timeout;
  let timeoutMs: number | undefined;
  if (timeout !== undefined) {
    const seconds = Number(timeout);
    if (!Number.isInteger(seconds) || seconds < 300 || seconds > 7200)
      throw new Error("--timeout must be 300 to 7200 seconds");
    timeoutMs = seconds * 1000;
  }
  // Fail fast on bad settings before creating the run; resume reuses the snapshot.
  const settings = values.settings
    ? loadLoopSettings(resolve(values.settings))
    : defaultLoopSettings();
  if (timeoutMs !== undefined) {
    settings.deadlines.setupMs = timeoutMs;
    settings.deadlines.checkMs = timeoutMs;
  }
  // Settings are resolved above, so even the top-level probe uses the run's Git deadline.
  const probe: CommandContext = { cwd: resolve(values.repo), timeoutMs: settings.deadlines.gitMs };
  const repo = await git(probe, "rev-parse", "--show-toplevel");
  const repoContext: CommandContext = { cwd: repo, timeoutMs: settings.deadlines.gitMs };
  const origin = await originUrl(repoContext);
  const host = githubHostFromOrigin(origin);
  const repositoryUrl = origin.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  const metadata = JSON.parse(
    await gh(
      repoContext,
      host,
      "repo",
      "view",
      repositoryUrl,
      "--json",
      "nameWithOwner,defaultBranchRef",
    ),
  ) as { nameWithOwner: string; defaultBranchRef: { name: string } };
  if (!/^[\w.-]+\/[\w.-]+$/.test(metadata.nameWithOwner) || !metadata.defaultBranchRef?.name)
    throw new Error("Cannot determine the GitHub repository and default branch");
  const baseBranch = values.base ?? metadata.defaultBranchRef.name;
  await git(repoContext, "check-ref-format", `refs/heads/${baseBranch}`);
  const { parent, tickets } = await snapshot(
    repoContext,
    host,
    metadata.nameWithOwner,
    Number(values.issue),
  );
  await git(repoContext, "fetch", "origin", `refs/heads/${baseBranch}`);
  const baseSha = await git(repoContext, "rev-parse", "FETCH_HEAD");
  const id = `${parent.number}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const runDir = join(dirname(repo), ".pi-issue-loops", `${basename(repo)}-${id}`);
  // Fail fast on unknown skills before creating the run; the copy lands in the
  // run dir below so resume reuses the snapshot.
  validateLoopSkills(settings);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  materializeLoopSkills(settings, runDir);
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
    settings,
    parent,
    tickets,
    sessions: [],
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
