// Runs the ketch CLI and classifies failures. Adapted from the ketch pi
// extension (1broseidon/ketch, plugins/pi/extensions/ketch.ts, MIT).

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** Runs a command; the same shape as `pi.exec`, so tests can pass a fake. */
export type Exec = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export type ErrorKind = "validation" | "not_found" | "upstream" | "precondition" | "cancelled";

export type RunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; kind: ErrorKind; message: string };

// Exit codes from ketch's cmd/exit.go. Any other non-zero code is upstream.
const EXIT_KIND: Record<number, ErrorKind> = {
  2: "validation",
  3: "not_found",
  4: "upstream",
  5: "precondition",
  6: "cancelled",
};

const MISSING = "ketch is not on PATH; install it with `brew install ketch`";

// Bound what we echo back from stderr so a chatty failure can't flood the model.
const STDERR_LIMIT = 2000;

export async function runKetch(
  exec: Exec,
  args: string[],
  signal: AbortSignal | undefined,
  timeout: number,
): Promise<RunResult> {
  let r: ExecResult;
  try {
    r = await exec("ketch", args, { signal, timeout });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return { ok: false, kind: "precondition", message: MISSING };
    return {
      ok: false,
      kind: "upstream",
      message: `ketch could not be started: ${e?.message ?? String(err)}`,
    };
  }
  if (r.killed) {
    const why = signal?.aborted
      ? "the call was cancelled"
      : `the call exceeded its ${Math.round(timeout / 1000)}s budget`;
    return { ok: false, kind: "cancelled", message: `ketch ${args[0]}: ${why}` };
  }
  if (r.code === 0) return { ok: true, stdout: r.stdout, stderr: r.stderr };
  // pi.exec swallows spawn errors, so a missing binary comes back as a bare
  // non-zero exit with both streams empty; ketch always explains a failure.
  if ((r.stdout === "" && r.stderr === "") || /ENOENT/.test(r.stderr)) {
    return { ok: false, kind: "precondition", message: MISSING };
  }
  // Cobra prefixes the error with "Error: "; the kind replaces it.
  const detail = tail(r.stderr.replace(/^\s*Error: /, ""), STDERR_LIMIT);
  return {
    ok: false,
    kind: EXIT_KIND[r.code] ?? "upstream",
    message: detail || `ketch exited ${r.code}`,
  };
}

/** stderr lines from a successful call are warnings, such as one URL of a batch failing. */
export function warningsOf(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim().replace(/^warn:\s*/i, ""))
    .filter(Boolean);
}

function tail(s: string, limit: number): string {
  const t = s.trim();
  return t.length <= limit ? t : `…${t.slice(t.length - limit)}`;
}
