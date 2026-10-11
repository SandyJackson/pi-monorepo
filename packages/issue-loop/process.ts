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
    let outputBytes = 0;
    let failure: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminated = false;
    let escalationComplete = false;
    let finished = false;
    let settleAfterEscalation: (() => void) | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const groupAlive = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const escalate = () => {
      clearTimeout(killTimer);
      killTimer = undefined;
      kill("SIGKILL");
      escalationComplete = true;
      const pending = settleAfterEscalation;
      settleAfterEscalation = undefined;
      pending?.();
    };
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      kill("SIGTERM");
      killTimer = setTimeout(escalate, 2_000);
    };
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      terminate();
    };
    const interrupt = () => {
      if (terminated) escalate();
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
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const complete = () => {
        cleanup();
        settle();
      };
      // A closed leader does not prove its descendants are gone. Keep the
      // escalation and wait for bounded group cleanup before releasing callers.
      if (!escalationComplete && groupAlive()) {
        terminate();
        settleAfterEscalation = complete;
      } else complete();
    };
    const collect = (data: string, stream: "stdout" | "stderr") => {
      if (options.log) appendFileSync(options.log, data);
      if (!failure) {
        if (stream === "stdout") stdout += data;
        else stderr += data;
        outputBytes += Buffer.byteLength(data, "utf8");
        if (outputBytes > 16 * 1024 * 1024) stop("Command output exceeded 16 MiB");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => collect(data, "stdout"));
    child.stderr.on("data", (data) => collect(data, "stderr"));
    child.stdin.on("error", () => {
      /* The child can exit before consuming its prompt. */
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => {
      if (failure || code !== 0 || signal) {
        const exitReason = signal
          ? `${program} terminated by ${signal}`
          : `${program} exited ${code}`;
        const diagnostic = [tailText(stdout, 2000), tailText(stderr, 2000)]
          .map((text) => text.trim())
          .filter(Boolean)
          .join("\n");
        const error = new Error(
          `${failure ?? exitReason}\n${diagnostic}${options.log ? `\nLog: ${options.log}` : ""}`,
        );
        if (failure || signal) error.name = "CommandStoppedError";
        finish(() => reject(error));
      } else finish(() => resolve(stdout.trim()));
    });
    child.stdin.end(options.input);
  });
}

export const git = (cwd: string, ...args: string[]) => command("git", args, { cwd });

/** Last `max` chars without splitting a surrogate pair at the cut. */
export function tailText(text: string, max: number): string {
  const tail = text.slice(-max);
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
}

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
