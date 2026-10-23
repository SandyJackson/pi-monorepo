import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "integration-lock.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "integration-lock-"));
  roots.push(root);
  const lock = join(root, "integration.lock");
  const log = join(root, "events.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_MONOREPO_INTEGRATION_LOCK: lock,
    PI_MONOREPO_INTEGRATION_SLOTS: "1",
  };
  delete env.PI_MONOREPO_INTEGRATION_LOCK_HELD;
  // A locked command that records when it starts and finishes.
  const task = (name: string, ms = 0, status = 0) => [
    process.execPath,
    "-e",
    `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(log)},"${name}-start\\n");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},"${name}-end\\n");process.exit(${status})},${ms})`,
  ];
  const events = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const slot = join(root, "integration.lock.0");
  const ownerFile = join(slot, "owner.json");
  return { root, lock, slot, ownerFile, env, task, events };
}

async function startHolder(f: ReturnType<typeof fixture>, name: string, ms: number) {
  const holder = spawn(process.execPath, [script, ...f.task(name, ms)], { env: f.env });
  const exited = new Promise((done) => holder.on("exit", done));
  for (let i = 0; i < 100 && !f.events().includes(`${name}-start`); i++)
    await new Promise((done) => setTimeout(done, 20));
  return { holder, exited };
}

it("queues a run while every slot is held", async () => {
  const f = fixture();
  const { holder: first, exited: firstExit } = await startHolder(f, "a", 600);
  const second = spawnSync(process.execPath, [script, ...f.task("b")], {
    env: f.env,
    encoding: "utf8",
  });
  await firstExit;
  expect(second.status).toBe(0);
  expect(second.stdout).toContain(
    `Waiting for an integration test slot; running: pid ${first.pid}`,
  );
  expect(f.events()).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  expect(existsSync(f.slot)).toBe(false);
});

it("lets runs overlap up to the slot count", async () => {
  const f = fixture();
  f.env.PI_MONOREPO_INTEGRATION_SLOTS = "2";
  const { exited } = await startHolder(f, "a", 600);
  const second = spawnSync(process.execPath, [script, ...f.task("b")], {
    env: f.env,
    encoding: "utf8",
  });
  await exited;
  expect(second.status).toBe(0);
  expect(second.stdout).not.toContain("Waiting");
  expect(f.events()).toEqual(["a-start", "b-start", "b-end", "a-end"]);
});

it("reclaims a lock left by a process that has exited", () => {
  const f = fixture();
  const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid;
  mkdirSync(f.slot);
  writeFileSync(
    f.ownerFile,
    JSON.stringify({ pid: dead, command: "crashed", startedAt: "earlier" }),
  );
  const result = spawnSync(process.execPath, [script, ...f.task("a")], { env: f.env });
  expect(result.status).toBe(0);
  expect(f.events()).toEqual(["a-start", "a-end"]);
  expect(existsSync(f.slot)).toBe(false);
});

it("does not wait on a lock already held by a parent run", () => {
  const f = fixture();
  mkdirSync(f.slot);
  writeFileSync(
    f.ownerFile,
    JSON.stringify({ pid: process.pid, command: "parent", startedAt: "now" }),
  );
  const result = spawnSync(process.execPath, [script, ...f.task("a")], {
    env: { ...f.env, PI_MONOREPO_INTEGRATION_LOCK_HELD: f.lock },
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  expect(f.events()).toEqual(["a-start", "a-end"]);
  // The parent's slot is left for the parent to release.
  expect(existsSync(f.slot)).toBe(true);
});

it("propagates the command's exit status and releases the lock", () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [script, ...f.task("a", 0, 3)], { env: f.env });
  expect(result.status).toBe(3);
  expect(existsSync(f.slot)).toBe(false);
});
