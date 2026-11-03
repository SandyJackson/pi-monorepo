/**
 * The scripted tmux in test-support.ts against real tmux on a disposable
 * server: the same launches and assertions run on both, so the unit tests'
 * model of tmux's environment handling is checked against tmux itself.
 *
 * The child "Pi" is a small script that records its environment, reports
 * readiness with its launch nonce, and then waits.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLive, isAttached } from "./launch.ts";
import { createStore, type Store } from "./store.ts";
import { createFakeTmux } from "./test-support.ts";
import { createTmuxExec, type TmuxExec } from "./tmux.ts";

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * What every launcher here keeps from the test process: tmux is found on its
 * PATH, and TMUX_TMPDIR puts the server where cleanup looks for it.
 */
const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
if (process.env.TMUX_TMPDIR) base.TMUX_TMPDIR = process.env.TMUX_TMPDIR;
const socket = `pi-sa-launch-${randomBytes(4).toString("hex")}`;
let root: string;
let fakePi: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-subagent-launch-it-")));
  fakePi = path.join(root, "fake-pi.mjs");
  fs.writeFileSync(
    fakePi,
    `import * as fs from "node:fs";
const childDir = process.argv[process.argv.indexOf("--subagent-child") + 1];
fs.writeFileSync(childDir + "/env.json", JSON.stringify(process.env));
fs.writeFileSync(childDir + "/cwd.txt", process.cwd());
const status = { version: 1, nonce: process.env.PI_SUBAGENT_NONCE, pid: process.pid, state: "idle" };
fs.writeFileSync(childDir + "/status.json", JSON.stringify(status));
setInterval(() => {}, 1000);
`,
  );
});

afterAll(() => {
  if (hasTmux) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // No server left to kill.
    }
    // tmux 3.8 can leave the socket file behind after its server exits.
    const uid = process.getuid?.();
    if (uid !== undefined) {
      const dir = fs.realpathSync(process.env.TMUX_TMPDIR || "/tmp");
      fs.rmSync(path.join(dir, `tmux-${uid}`, socket), { force: true });
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** The fake runs the script's work itself when tmux would start it. */
function fakeTmux(): TmuxExec {
  return createFakeTmux({
    onNewSession: (session) => {
      const childDir = session.command[session.command.indexOf("--subagent-child") + 1];
      fs.writeFileSync(path.join(childDir, "env.json"), JSON.stringify(session.env));
      fs.writeFileSync(path.join(childDir, "cwd.txt"), session.cwd);
      const status = { version: 1, nonce: session.env.PI_SUBAGENT_NONCE, pid: 1, state: "idle" };
      fs.writeFileSync(path.join(childDir, "status.json"), JSON.stringify(status));
    },
  }).exec;
}

const backends = [
  { name: "scripted tmux", skip: false, exec: fakeTmux },
  { name: "real tmux", skip: !hasTmux, exec: () => createTmuxExec(socket) },
];

describe.each(backends)("$name", ({ name, skip, exec }) => {
  let store: Store;
  let tmux: TmuxExec;

  beforeAll(() => {
    store = createStore(path.join(root, name.replace(" ", "-")));
    tmux = exec();
  });

  function addChild(cwd = root): string {
    return store.createChild(
      {
        parent: { sessionId: "parent" },
        worktree: root,
        cwd,
        agent: { name: "scout", source: "user" },
        projectTrust: false,
        depth: 1,
        piCommand: [process.execPath, fakePi],
      },
      "",
    ).childId;
  }

  function childEnv(childId: string): Record<string, string> {
    return JSON.parse(fs.readFileSync(path.join(store.childDir(childId), "env.json"), "utf8"));
  }

  it.skipIf(skip)(
    "isolates concurrent cold-start launchers without reading environment values into command output",
    async () => {
      const first = addChild();
      const second = addChild();
      const calls: string[][] = [];
      const tracked: TmuxExec = (args, options) => {
        calls.push([...args]);
        return tmux(args, options);
      };
      const results = await Promise.all([
        ensureLive(first, {
          store,
          tmux: tracked,
          env: { ...base, ONLY_FIRST: "first-secret", MULTILINE: "first\nsecret=value" },
        }),
        ensureLive(second, {
          store,
          tmux: tracked,
          env: { ...base, ONLY_SECOND: "second-secret", MULTILINE: "second\nsecret=value" },
        }),
      ]);

      expect(results.map((result) => result.status)).toEqual(["live", "live"]);
      expect(childEnv(first)).toMatchObject({
        ONLY_FIRST: "first-secret",
        MULTILINE: "first\nsecret=value",
      });
      expect(childEnv(first)).not.toHaveProperty("ONLY_SECOND");
      expect(childEnv(second)).toMatchObject({
        ONLY_SECOND: "second-secret",
        MULTILINE: "second\nsecret=value",
      });
      expect(childEnv(second)).not.toHaveProperty("ONLY_FIRST");
      expect(calls).not.toContainEqual(["show-environment", "-g"]);
      expect(JSON.stringify(calls)).not.toMatch(/first-secret|second-secret|secret=value/);
    },
    20_000,
  );

  it.skipIf(skip)(
    "gives each child its own launcher's variables, not those of the launcher that started the server",
    async () => {
      // A later launcher must override shared values and remove absent variables.
      const first = addChild();
      const firstLive = await ensureLive(first, {
        store,
        tmux,
        env: { ...base, OTHER_KEY: "theirs", SHARED: "old" },
      });
      expect(firstLive.status).toBe("live");

      const second = addChild();
      const secondLive = await ensureLive(second, {
        store,
        tmux,
        env: { ...base, OWN_KEY: "mine", SHARED: "new" },
      });
      expect(secondLive.status).toBe("live");

      expect(childEnv(first)).toMatchObject({ OTHER_KEY: "theirs", SHARED: "old" });
      expect(childEnv(second)).toMatchObject({ OWN_KEY: "mine", SHARED: "new" });
      expect(childEnv(second)).not.toHaveProperty("OTHER_KEY");
      expect(childEnv(second).PI_SUBAGENT_NONCE).toBe(
        secondLive.status === "live" ? secondLive.nonce : "",
      );
    },
    20_000,
  );

  it.skipIf(skip).each(["#{session_name}", "#S", "trailing;"])(
    "launches in the literal directory %s, not a tmux format or command separator",
    async (directory) => {
      const cwd = path.join(root, directory);
      fs.mkdirSync(cwd, { recursive: true });
      const childId = addChild(cwd);

      expect((await ensureLive(childId, { store, tmux, env: base })).status).toBe("live");
      expect(fs.readFileSync(path.join(store.childDir(childId), "cwd.txt"), "utf8")).toBe(cwd);
    },
  );

  it.skipIf(skip)("counts a child without a session as attached, never as unviewed", async () => {
    // Runs after the launches above, so the server is up and only the session is missing.
    expect(await isAttached(tmux, "scout-none")).toBe(true);
  });
});
