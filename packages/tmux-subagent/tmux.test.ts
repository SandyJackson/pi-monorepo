import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChildRecord } from "./store.ts";
import {
  buildNewSessionArgs,
  buildPiArguments,
  createTmuxExec,
  launchEnvironment,
  projectTrustFor,
  TMUX_CONF,
  tmuxSocket,
} from "./tmux.ts";

const child: ChildRecord = {
  version: 1,
  childId: "scout-7k2q",
  createdAt: "2026-01-01T00:00:00.000Z",
  parent: { sessionId: "parent" },
  worktree: "/repo",
  cwd: "/repo",
  agent: { name: "scout", source: "user" },
  projectTrust: true,
  depth: 1,
  piCommand: ["/node", "/pi/cli.js"],
};

const dir = "/state/children/scout-7k2q";

describe("Pi launch arguments", () => {
  it("passes session identity, prompt, trust and child flags without optional settings", () => {
    expect(buildPiArguments(child, dir)).toEqual([
      "--session-dir",
      `${dir}/session`,
      "--session-id",
      "scout-7k2q",
      "--no-mcp",
      "--approve",
      "--append-system-prompt",
      `${dir}/system-prompt.md`,
      "--subagent-child",
      dir,
    ]);
  });

  it("passes model and thinking, and adds exactly subagent_report to a tool allowlist", () => {
    const args = buildPiArguments(
      {
        ...child,
        agent: { ...child.agent, model: "mock/echo", thinking: "low", tools: ["read", "grep"] },
      },
      dir,
    );
    expect(args.slice(4, 11)).toEqual([
      "--no-mcp",
      "--model",
      "mock/echo",
      "--thinking",
      "low",
      "--tools",
      "read,grep,subagent_report",
    ]);
  });

  it("leaves Pi's default toolset alone when the agent has no allowlist", () => {
    for (const tools of [undefined, []]) {
      const args = buildPiArguments({ ...child, agent: { ...child.agent, tools } }, dir);
      expect(args).not.toContain("--tools");
    }
  });

  it("passes --no-approve for an untrusted child", () => {
    const args = buildPiArguments({ ...child, projectTrust: false }, dir);
    expect(args).toContain("--no-approve");
    expect(args).not.toContain("--approve");
  });
});

describe("project trust", () => {
  it.each([
    { parentTrusted: true, cwd: "/repo", expected: true },
    { parentTrusted: true, cwd: "/repo/packages/a", expected: true },
    { parentTrusted: true, cwd: "/repository", expected: false },
    { parentTrusted: true, cwd: "/elsewhere", expected: false },
    { parentTrusted: false, cwd: "/repo", expected: false },
  ])("trusted=$parentTrusted cwd=$cwd gives $expected", ({ parentTrusted, cwd, expected }) => {
    expect(projectTrustFor({ parentTrusted, parentCwd: "/repo", cwd })).toBe(expected);
  });
});

describe("private tmux server", () => {
  it("starts a child session from argv with the private config, cwd, nonce and environment", () => {
    expect(
      buildNewSessionArgs({
        confPath: "/state/tmux.conf",
        childId: "scout-7k2q",
        cwd: "/repo dir",
        nonce: "abc",
        env: { HOME: "/home/me", "WITH SPACE": "a b; rm -rf /" },
        command: ["/node", "/pi/cli.js", "--no-mcp"],
      }),
    ).toEqual([
      "-f",
      "/state/tmux.conf",
      "new-session",
      "-d",
      "-s",
      "sa-scout-7k2q",
      "-c",
      "/repo dir",
      "-e",
      "PI_SUBAGENT_NONCE=abc",
      "-e",
      "HOME=/home/me",
      "-e",
      "WITH SPACE=a b; rm -rf /",
      "--",
      "/node",
      "/pi/cli.js",
      "--no-mcp",
    ]);
  });

  it("drops tmux nesting variables, a stale nonce and unset values from the launch environment", () => {
    expect(
      launchEnvironment({
        PATH: "/bin",
        TMUX: "/tmp/tmux-1/default,1,0",
        TMUX_PANE: "%1",
        PI_SUBAGENT_NONCE: "old",
        EMPTY: undefined,
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("configures the server so the user's config, keys and status line never apply", () => {
    for (const line of [
      "set -g prefix None",
      "set -g prefix2 None",
      "unbind-key -a -T root",
      "unbind-key -a -T prefix",
      "set -g status off",
      "set -s escape-time 0",
      "set -s extended-keys on",
      "set -s extended-keys-format csi-u",
      "set -s exit-empty on",
      "set -s exit-unattached off",
      "set -g destroy-unattached off",
      "set -g remain-on-exit off",
    ]) {
      expect(TMUX_CONF.split("\n")).toContain(line);
    }
  });

  it("uses the pi-subagents socket unless overridden", () => {
    expect(tmuxSocket({})).toBe("pi-subagents");
    expect(tmuxSocket({ PI_SUBAGENT_TMUX_SOCKET: "test-socket" })).toBe("test-socket");
  });

  it("runs tmux on the named socket from argv, reporting exit codes instead of throwing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-tmux-"));
    try {
      const fake = path.join(dir, "tmux");
      fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s|" "$@"\necho oops >&2\nexit 3\n', {
        mode: 0o755,
      });
      const result = await createTmuxExec("test-socket", fake)(["has-session", "-t", "=a b"]);
      expect(result).toEqual({
        code: 3,
        stdout: "-L|test-socket|has-session|-t|=a b|",
        stderr: "oops\n",
      });
      await expect(createTmuxExec("x", path.join(dir, "missing"))(["-V"])).rejects.toThrow(
        /ENOENT/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
