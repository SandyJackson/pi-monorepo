import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { command } from "./process.ts";

it("kills an interrupt-resistant descendant before releasing an interrupted command", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-command-"));
  const socketPath = join(root, "ready.sock");
  const server = createServer();
  let descendantPid: number | undefined;
  let socket: Socket | undefined;
  try {
    server.listen(socketPath);
    await once(server, "listening");
    const connection = once(server, "connection");
    const descendant = `
      process.on('SIGTERM', () => {});
      const socket = require('node:net').createConnection(${JSON.stringify(socketPath)}, () => {
        socket.write(String(process.pid));
      });
      setInterval(() => {}, 1000);
    `;
    const leader = `
      process.on('SIGTERM', () => process.exit(0));
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'});
      setInterval(() => {}, 1000);
    `;
    const result = command(process.execPath, ["-e", leader], { cwd: root, timeoutMs: 10_000 });
    const stopped = expect(result).rejects.toMatchObject({
      name: "CommandStoppedError",
      message: "Interrupted; work has been preserved\n",
    });
    [socket] = (await connection) as [Socket];
    const [ready] = await once(socket, "data");
    descendantPid = Number(ready.toString());
    expect(descendantPid).toBeGreaterThan(0);
    const exited = once(socket, "close");
    // Readiness proves the descendant installed its signal handler. Interrupt
    // the command immediately rather than sleeping to trigger its deadline.
    process.emit("SIGTERM");
    await stopped;
    // This is only a short hang safeguard. The descendant never closes its
    // socket voluntarily, so closure proves process cleanup actually happened.
    expect(await Promise.race([exited.then(() => true), delay(1000).then(() => false)])).toBe(true);
  } finally {
    if (descendantPid) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
    }
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
