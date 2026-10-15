import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideWorktreeTrust } from "./worktree-trust.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, stdio: "ignore" });
}

function writeFile(path: string, content = "x\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commitAll(cwd: string, message: string): void {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
}

describe("decideWorktreeTrust", () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let trustStore: ProjectTrustStore;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-trust-")));
    repo = join(root, "repo");
    worktree = join(root, "elsewhere", "worktree");
    trustStore = new ProjectTrustStore(join(root, "agent"));

    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFile(join(repo, ".agents", "skills", "demo", "SKILL.md"), "trusted\n");
    writeFile(join(repo, "src", "index.ts"));
    commitAll(repo, "init");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("trusts a linked worktree of a trusted repo whose project resources are unchanged", async () => {
    trustStore.set(repo, true);
    writeFile(join(worktree, "src", "index.ts"), "edited\n");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("yes");
  });

  it("trusts a detached worktree outside any trusted folder", async () => {
    trustStore.set(repo, true);
    const detached = join(root, "tmp", "head");
    git(repo, "worktree", "add", "-q", "--detach", detached, "main");

    expect(await decideWorktreeTrust(detached, trustStore)).toBe("yes");
  });

  it("is undecided when the repo's main worktree is not trusted", async () => {
    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");

    trustStore.set(repo, false);
    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided for the main worktree itself", async () => {
    expect(await decideWorktreeTrust(repo, trustStore)).toBe("undecided");
  });

  it("is undecided outside a git repository", async () => {
    const plain = join(root, "plain");
    writeFile(join(plain, ".agents", "skills", "demo", "SKILL.md"));

    expect(await decideWorktreeTrust(plain, trustStore)).toBe("undecided");
  });

  it("defers to a saved decision that already covers the worktree", async () => {
    trustStore.set(repo, true);
    trustStore.set(worktree, false);

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when the worktree's branch commits a skill change", async () => {
    trustStore.set(repo, true);
    writeFile(join(worktree, ".agents", "skills", "demo", "SKILL.md"), "changed\n");
    commitAll(worktree, "change skill");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when a skill has uncommitted edits", async () => {
    trustStore.set(repo, true);
    writeFile(join(worktree, ".agents", "skills", "demo", "SKILL.md"), "changed\n");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when an untracked skill is added", async () => {
    trustStore.set(repo, true);
    writeFile(join(worktree, ".agents", "skills", "extra", "SKILL.md"));

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when ignored Pi config exists in the worktree", async () => {
    trustStore.set(repo, true);
    writeFile(join(repo, ".gitignore"), ".pi/\n");
    commitAll(repo, "ignore pi config");
    git(worktree, "merge", "-q", "--ff-only", "main");
    writeFile(join(worktree, ".pi", "settings.json"), "{}\n");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when Pi config exists, even unchanged from the main worktree", async () => {
    writeFile(join(repo, ".pi", "settings.json"), '{ "extensions": ["../src/index.ts"] }\n');
    commitAll(repo, "add pi settings");
    trustStore.set(repo, true);
    git(worktree, "merge", "-q", "--ff-only", "main");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "is undecided when a skill edit is hidden by %s",
    async (flag) => {
      trustStore.set(repo, true);
      const skill = join(worktree, ".agents", "skills", "demo", "SKILL.md");
      git(worktree, "update-index", flag, skill);
      writeFile(skill, "changed\n");

      expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
    },
  );

  it("is undecided when a skill is a submodule", async () => {
    const nested = join(repo, ".agents", "skills", "nested");
    mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    writeFile(join(nested, "SKILL.md"));
    commitAll(nested, "nested skill");
    commitAll(repo, "add nested skill repository");
    trustStore.set(repo, true);
    git(worktree, "merge", "-q", "--ff-only", "main");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when an untracked symlink is added to the skills", async () => {
    trustStore.set(repo, true);
    writeFile(join(root, "outside.md"));
    mkdirSync(join(worktree, ".agents", "skills", "linked"));
    symlinkSync(
      join(root, "outside.md"),
      join(worktree, ".agents", "skills", "linked", "SKILL.md"),
    );

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when the skills directory is reached through a symlink", async () => {
    trustStore.set(repo, true);
    const outside = join(root, "outside-agents");
    writeFile(join(outside, "skills", "demo", "SKILL.md"), "trusted\n");
    rmSync(join(worktree, ".agents"), { recursive: true });
    symlinkSync(outside, join(worktree, ".agents"));

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when a file whose name contains a tab is renamed into a skill", async () => {
    writeFile(join(repo, ".agents", "skills", "evil", "SKILL.md\tunused"));
    commitAll(repo, "add tab-named file");
    trustStore.set(repo, true);
    git(worktree, "merge", "-q", "--ff-only", "main");
    const evil = join(worktree, ".agents", "skills", "evil");
    renameSync(join(evil, "SKILL.md\tunused"), join(evil, "SKILL.md"));

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when a skill is deleted", async () => {
    trustStore.set(repo, true);
    rmSync(join(worktree, ".agents", "skills", "demo"), { recursive: true });

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when .agents is a submodule with changed skills", async () => {
    git(repo, "rm", "-rq", ".agents");
    const nested = join(repo, ".agents");
    mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    writeFile(join(nested, "skills", "demo", "SKILL.md"), "trusted\n");
    commitAll(nested, "nested skills");
    commitAll(repo, "move skills into a submodule");
    trustStore.set(repo, true);
    git(worktree, "merge", "-q", "--ff-only", "main");
    writeFile(join(worktree, ".agents", "skills", "demo", "SKILL.md"), "changed\n");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when skills appear in an untracked nested repository", async () => {
    git(repo, "rm", "-rq", ".agents");
    commitAll(repo, "remove skills");
    trustStore.set(repo, true);
    git(worktree, "merge", "-q", "--ff-only", "main");
    const nested = join(worktree, ".agents");
    mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    writeFile(join(nested, "skills", "demo", "SKILL.md"));
    commitAll(nested, "nested skills");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when Git attributes hide a skill edit from git diff", async () => {
    writeFile(join(repo, ".agents", "skills", "demo", "SKILL.md"), "description: $Id$\n");
    commitAll(repo, "add ident token");
    trustStore.set(repo, true);
    git(worktree, "merge", "-q", "--ff-only", "main");
    writeFile(join(worktree, ".gitattributes"), "*.md ident\n");
    writeFile(
      join(worktree, ".agents", "skills", "demo", "SKILL.md"),
      "description: $Id: injected instructions $\n",
    );

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when a committed symlink exposes unchanged repo files as Pi config", async () => {
    trustStore.set(repo, true);
    writeFile(join(repo, "fixtures", "pi", "settings.json"), "{}\n");
    commitAll(repo, "add fixture");
    git(worktree, "merge", "-q", "--ff-only", "main");
    symlinkSync("fixtures/pi", join(worktree, ".pi"));
    commitAll(worktree, "link pi config");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("is undecided when a skill is a symlink, even one the main worktree shares", async () => {
    symlinkSync("../../src", join(repo, ".agents", "skills", "linked"));
    commitAll(repo, "link skill");
    trustStore.set(repo, true);
    git(worktree, "merge", "-q", "--ff-only", "main");

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });

  it("checks project resources Pi would load from a subdirectory cwd", async () => {
    trustStore.set(repo, true);
    const subdirectory = join(worktree, "src");

    expect(await decideWorktreeTrust(subdirectory, trustStore)).toBe("yes");

    writeFile(join(subdirectory, ".agents", "skills", "nested", "SKILL.md"));
    expect(await decideWorktreeTrust(subdirectory, trustStore)).toBe("undecided");
  });

  it("is undecided when an ancestor outside the worktree has skills", async () => {
    trustStore.set(repo, true);
    writeFile(join(root, "elsewhere", ".agents", "skills", "outer", "SKILL.md"));

    expect(await decideWorktreeTrust(worktree, trustStore)).toBe("undecided");
  });
});
