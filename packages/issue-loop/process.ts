import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  log?: string;
  input?: string;
  env?: Record<string, string | undefined>;
}

/** Run trusted commands without shell interpolation; only setup/check explicitly use a shell. */
export function command(program: string, args: string[], options: CommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.log) writeFileSync(options.log, "", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (options.env)
      for (const [key, value] of Object.entries(options.env)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    const child = spawn(program, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const interrupt = () => {
      if (failure) kill("SIGKILL");
      else stop("Interrupted; work has been preserved");
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const timer = setTimeout(
      () => stop(`Timed out running ${program}`),
      options.timeoutMs ?? 60_000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    };
    const collect = (data: string, stream: "stdout" | "stderr") => {
      if (options.log) appendFileSync(options.log, data);
      if (!failure) {
        if (stream === "stdout") stdout += data;
        else stderr += data;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => collect(data, "stdout"));
    child.stderr.on("data", (data) => collect(data, "stderr"));
    child.stdin.on("error", () => {
      /* The child can exit before consuming its prompt. */
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (failure || code !== 0 || signal) {
        const exitReason = signal
          ? `${program} terminated by ${signal}`
          : `${program} exited ${code}`;
        const error = new Error(
          `${failure ?? exitReason}\n${stderr.slice(-4000)}${options.log ? `\nLog: ${options.log}` : ""}`,
        );
        if (failure || signal) error.name = "CommandStoppedError";
        reject(error);
      } else resolve(stdout.trim());
    });
    child.stdin.end(options.input);
  });
}

export const git = (cwd: string, ...args: string[]) => command("git", args, { cwd });

export async function originUrl(cwd: string): Promise<string> {
  const fetchUrls = (await git(cwd, "remote", "get-url", "--all", "origin")).split("\n");
  const pushUrls = (await git(cwd, "remote", "get-url", "--push", "--all", "origin")).split("\n");
  if (
    fetchUrls.length !== 1 ||
    pushUrls.length !== 1 ||
    !fetchUrls[0] ||
    fetchUrls[0] !== pushUrls[0]
  ) {
    throw new Error("origin must have exactly one fetch URL and one identical push URL");
  }
  return fetchUrls[0];
}
