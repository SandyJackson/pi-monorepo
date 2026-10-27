/**
 * The picker, float, and stop against real tmux on disposable servers:
 *
 * - `host` gives the outer client a real terminal,
 * - `outer` stands in for the operator's server, with the README binding,
 * - `private` stands in for `pi-subagents`.
 *
 * The child "Pi" is a small script that reports readiness with its launch
 * nonce and then waits, so no model or Pi build is involved.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createStore, type Store } from "./store.ts";

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tag = randomBytes(4).toString("hex");
const sockets = { host: `t08-host-${tag}`, outer: `t08-outer-${tag}`, private: `t08-priv-${tag}` };
const cliPath = path.join(import.meta.dirname, "cli.ts");

let root: string;
let worktree: string;
let store: Store;
let env: NodeJS.ProcessEnv;

/** Run tmux on one of this test's servers. Never without `-L`. */
function tmux(server: keyof typeof sockets, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", ["-L", sockets[server], ...args], { env }, (error, stdout, stderr) =>
      error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
    );
  });
}

function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const screen = () => tmux("host", "capture-pane", "-p", "-t", "=h:");
const floats = async () =>
  (await tmux("outer", "list-panes", "-a", "-F", "#{pane_floating_flag}"))
    .split("\n")
    .filter((flag) => flag === "1").length;
/** The outer session's tiled pane, or its float. */
async function paneId(floating: boolean): Promise<string> {
  const panes = await tmux(
    "outer",
    "list-panes",
    "-t",
    "=outer:",
    "-F",
    "#{pane_floating_flag} #{pane_id}",
  );
  const line = panes.split("\n").find((entry) => entry.startsWith(floating ? "1 " : "0 "));
  if (!line) throw new Error(`No ${floating ? "floating" : "tiled"} pane in ${panes}`);
  return line.slice(2);
}
const attached = async (childId: string) =>
  (
    await tmux("private", "display-message", "-p", "-t", `=sa-${childId}:`, "#{session_attached}")
  ).trim();

beforeAll(async () => {
  if (!hasTmux) return;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-cli-it-")));
  worktree = path.join(root, "repo");
  fs.mkdirSync(worktree);
  const agentDir = path.join(root, "agent");
  store = createStore(path.join(agentDir, "subagents"));

  env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENT_TMUX_SOCKET: sockets.private,
    PI_SUBAGENT_OUTER_TMUX_SOCKET: sockets.outer,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.PI_SUBAGENT_NONCE;

  // Neither test server loads the operator's configuration.
  const outerConf = path.join(root, "outer.conf");
  fs.writeFileSync(
    outerConf,
    [
      "set -g status off",
      "set -s extended-keys on",
      "set -s extended-keys-format csi-u",
      `bind-key -n F12 run-shell -b '${process.execPath} ${cliPath} pick --pane "#{pane_id}"'`,
      "",
    ].join("\n"),
  );
  // The outer server copies this environment, so the binding's CLI sees the test sockets.
  await tmux(
    "outer",
    "-f",
    outerConf,
    "new-session",
    "-d",
    "-s",
    "outer",
    "-c",
    worktree,
    "--",
    "sleep",
    "3600",
  );
  const emptyConf = path.join(root, "empty.conf");
  fs.writeFileSync(emptyConf, "set -g status off\n");
  await tmux(
    "host",
    "-f",
    emptyConf,
    "new-session",
    "-d",
    "-s",
    "h",
    "-x",
    "160",
    "-y",
    "45",
    "--",
    "env",
    "-u",
    "TMUX",
    "-u",
    "TMUX_PANE",
    "tmux",
    "-L",
    sockets.outer,
    "attach",
    "-t",
    "=outer",
  );
  await waitFor(
    async () => ((await tmux("outer", "list-clients")).trim() ? true : undefined),
    "the outer client",
  );
}, 30_000);

afterAll(() => {
  if (!hasTmux) return;
  for (const socket of Object.values(sockets)) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {}
    // tmux 3.8 leaves the socket file behind.
    const uid = process.getuid?.() ?? 0;
    const dir = process.env.TMUX_TMPDIR || "/tmp";
    fs.rmSync(path.join(fs.realpathSync(dir), `tmux-${uid}`, socket), { force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

it.skipIf(!hasTmux)(
  "picks a child from the binding, floats it, refuses a second float, and stops the worktree",
  async () => {
    const fakePi = path.join(root, "fake-pi.mjs");
    // Report readiness the way the child bridge does, then stay up.
    fs.writeFileSync(
      fakePi,
      `import * as fs from "node:fs";
const childDir = process.argv[process.argv.indexOf("--subagent-child") + 1];
const status = { version: 1, nonce: process.env.PI_SUBAGENT_NONCE, pid: process.pid, state: "idle" };
fs.writeFileSync(childDir + "/status.json", JSON.stringify(status));
console.log("FAKE-PI-READY");
setInterval(() => {}, 1000);
`,
    );
    const child = store.createChild(
      {
        parent: { sessionId: "aaaaaaaa-1111", name: "planning" },
        worktree,
        cwd: worktree,
        agent: { name: "scout", source: "user" },
        projectTrust: false,
        label: "issue #12",
        depth: 1,
        piCommand: [process.execPath, fakePi],
      },
      "",
    );
    const drain = path.join(store.childDir(child.childId), "drain");
    fs.writeFileSync(drain, "");

    const listed = JSON.parse((await cli("list", "--json", "--worktree", worktree)).stdout);
    expect(listed.groups).toEqual([
      {
        title: "planning",
        children: [
          { childId: child.childId, agent: "scout", label: "issue #12", state: "stopped" },
        ],
      },
    ]);

    // The README binding opens the menu on the client's window.
    await tmux("host", "send-keys", "-t", "=h:", "F12");
    const menu = await waitFor(async () => {
      const text = await screen();
      return text.includes(child.childId) ? text : undefined;
    }, "the menu");
    expect(menu).toContain("planning");
    expect(menu).toContain("issue #12");

    // Choosing the item resumes the child and floats an attach client.
    await tmux("host", "send-keys", "-t", "=h:", "1");
    await waitFor(
      async () => ((await attached(child.childId)) === "1" ? true : undefined),
      "the float",
    );
    expect(await floats()).toBe(1);
    await waitFor(
      async () => ((await screen()).includes("FAKE-PI-READY") ? true : undefined),
      "the child in the float",
    );
    expect(fs.existsSync(drain)).toBe(true);

    // A second open on the same window is refused and leaves the float alone.
    const again = await cli("open", child.childId, "--pane", await paneId(false));
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("window already has a modal pane");
    expect(await floats()).toBe(1);

    // Dismissing the float leaves the child running.
    await tmux("outer", "kill-pane", "-t", await paneId(true));
    await waitFor(
      async () => ((await attached(child.childId)) === "0" ? true : undefined),
      "detach",
    );
    await tmux("private", "has-session", "-t", `=sa-${child.childId}`);

    const live = JSON.parse((await cli("list", "--json", "--worktree", worktree)).stdout);
    expect(live.groups[0].children[0].state).toBe("idle");

    const stopped = await cli("stop", "--worktree", worktree);
    expect(stopped).toMatchObject({ code: 0, stdout: `Stopped ${child.childId}\n` });
    await expect(tmux("private", "has-session", "-t", `=sa-${child.childId}`)).rejects.toThrow();
    expect(store.readChild(child.childId).childId).toBe(child.childId);
  },
  60_000,
);

it.skipIf(!hasTmux)("shows an empty menu for a worktree with no children", async () => {
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  const pane = (
    await tmux(
      "outer",
      "new-window",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "=outer:",
      "-c",
      empty,
      "--",
      "sleep",
      "3600",
    )
  ).trim();

  const result = await cli("pick", "--pane", pane);

  expect(result.code).toBe(0);
  await waitFor(
    async () => ((await screen()).includes("No subagents for this worktree") ? true : undefined),
    "the empty menu",
  );
  await tmux("host", "send-keys", "-t", "=h:", "Escape");
});
