import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Integration tests assert wall-clock deadlines. Two suites on one machine
// stay reliable, but four overlapping suites failed healthy tests, so runs from
// several agents share a small number of slots and queue for the rest.
const LOCK_PATH_ENV = "PI_MONOREPO_INTEGRATION_LOCK";
const SLOTS_ENV = "PI_MONOREPO_INTEGRATION_SLOTS";
// Child processes of a holder (e.g. tests that run the selector) must not
// wait for a slot their parent already holds.
const HELD_ENV = "PI_MONOREPO_INTEGRATION_LOCK_HELD";
const DEFAULT_SLOTS = 2;
const POLL_MS = 200;
const MAX_WAIT_MS = 20 * 60_000;

interface Owner {
  pid: number;
  command: string;
  startedAt: string;
}

export function integrationLockPath(): string {
  return process.env[LOCK_PATH_ENV] ?? join(tmpdir(), "pi-monorepo-integration.lock");
}

function slotCount(): number {
  const slots = Number(process.env[SLOTS_ENV] ?? DEFAULT_SLOTS);
  return Number.isInteger(slots) && slots > 0 ? slots : DEFAULT_SLOTS;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(path: string): Owner | undefined {
  try {
    return JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as Owner;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `task` while holding one of the machine-wide integration test slots. */
export function withIntegrationLock<T>(command: string, task: () => T): T {
  const base = integrationLockPath();
  if (process.env[HELD_ENV] === base) return task();
  const paths = Array.from({ length: slotCount() }, (_, slot) => `${base}.${slot}`);
  const deadline = Date.now() + MAX_WAIT_MS;
  const ownerlessPolls = new Map<string, number>();
  let reported = "";
  let held: string | undefined;
  while (!held) {
    const holders: Owner[] = [];
    for (const path of paths) {
      try {
        mkdirSync(path);
        held = path;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const owner = readOwner(path);
      // A holder writes its owner file immediately after mkdir; a slot that
      // stays ownerless, or whose owner has exited, was abandoned.
      const polls = owner ? 0 : (ownerlessPolls.get(path) ?? 0) + 1;
      ownerlessPolls.set(path, polls);
      if (owner ? !alive(owner.pid) : polls * POLL_MS > 5_000) {
        rmSync(path, { recursive: true, force: true });
        ownerlessPolls.delete(path);
      } else if (owner) holders.push(owner);
    }
    if (held) break;
    const pids = holders.map((owner) => owner.pid).join(", ");
    if (pids && pids !== reported) {
      reported = pids;
      console.log(
        `Waiting for an integration test slot; running: ${holders
          .map((owner) => `pid ${owner.pid} (${owner.command}, since ${owner.startedAt})`)
          .join("; ")}`,
      );
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${MAX_WAIT_MS / 60_000} minutes waiting for an integration test slot (${base}.*)${pids ? `; held by pid ${pids}` : ""}`,
      );
    sleep(POLL_MS);
  }
  const owner: Owner = { pid: process.pid, command, startedAt: new Date().toISOString() };
  writeFileSync(join(held, "owner.json"), JSON.stringify(owner));
  const previous = process.env[HELD_ENV];
  process.env[HELD_ENV] = base;
  try {
    return task();
  } finally {
    if (previous === undefined) delete process.env[HELD_ENV];
    else process.env[HELD_ENV] = previous;
    if (readOwner(held)?.pid === process.pid) rmSync(held, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Usage: node scripts/integration-lock.ts <command> [args...]
  const [program, ...args] = process.argv.slice(2);
  if (!program) {
    console.error("Usage: node scripts/integration-lock.ts <command> [args...]");
    process.exit(2);
  }
  const status = withIntegrationLock([program, ...args].join(" "), () => {
    const child = spawnSync(program, args, { stdio: "inherit" });
    if (child.error) throw child.error;
    return child.status ?? 1;
  });
  process.exit(status);
}
