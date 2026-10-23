// The output contract shared by every ketch tool: markdown `content` for the
// model, typed `structuredContent` for codemode scripts, and structured errors
// whose message says what the error kind means. Truncation with a temp-file
// spill follows pi-ketch (sovorn-c/pi-ketch, src/output.ts, MIT).
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentToolResult,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ErrorKind, type Exec, runKetch, warningsOf } from "./runner.ts";

/** Characters kept per fetched page unless a call sets max_chars. */
export const DEFAULT_MAX_CHARS = 6000;

// Said once per error instead of in every tool description.
const MEANING: Record<ErrorKind, string> = {
  validation: "fix the input; retrying it unchanged will fail again",
  not_found: "no such resource or match",
  upstream: "a backend or network failure; retrying may help",
  precondition: "ketch is missing or not configured; tell the user",
  cancelled: "the call was cancelled or ran out of time",
};

export const ErrorOutput = Type.Object({
  error: Type.Object({
    kind: Type.Union([
      Type.Literal("validation"),
      Type.Literal("not_found"),
      Type.Literal("upstream"),
      Type.Literal("precondition"),
      Type.Literal("cancelled"),
    ]),
    message: Type.String(),
  }),
});

/** What the TUI renderer reads. */
export interface KetchDetails {
  result?: Structured;
  fullOutputPath?: string;
}

export type KetchResult = AgentToolResult<KetchDetails>;

/** A value codemode scripts receive; Pi requires it to be JSON. */
export type Structured = NonNullable<KetchResult["structuredContent"]>;

export function errorResult(kind: ErrorKind, message: string): KetchResult {
  const error = { kind, message };
  return {
    content: [{ type: "text", text: `[${kind}] ${message} (${MEANING[kind]})` }],
    structuredContent: { error },
    details: {},
    isError: true,
  };
}

/**
 * Caps `text` at Pi's default output limits. When it is cut, the full text is
 * written to a temp file and the visible text ends with a note naming it.
 */
async function successResult(text: string, structured: Structured): Promise<KetchResult> {
  const details: KetchDetails = { result: structured };
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  let visible = truncation.content;
  if (truncation.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "pi-ketch-"));
    const path = join(dir, "output.md");
    await writeFile(path, text, "utf8");
    details.fullOutputPath = path;
    visible +=
      `\n\n[Output truncated: showing ${formatSize(truncation.outputBytes)} of ` +
      `${formatSize(truncation.totalBytes)}. Full output: ${path}]`;
  }
  return {
    content: [{ type: "text", text: visible }],
    structuredContent: structured,
    details,
  };
}

export interface Rendered {
  text: string;
  output: { [key: string]: Structured };
}

/**
 * Runs a ketch command that prints JSON and renders the parsed value. Warnings
 * on stderr, such as one URL of a batch failing, are added to both views.
 */
export async function runJson(
  exec: Exec,
  args: string[],
  signal: AbortSignal | undefined,
  timeout: number,
  render: (json: unknown) => Rendered,
): Promise<KetchResult> {
  const r = await runKetch(exec, args, signal, timeout);
  if (!r.ok) return errorResult(r.kind, r.message);
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return errorResult("upstream", `ketch ${args[0]} returned output that isn't JSON`);
  }
  const { text, output } = render(json);
  const warnings = warningsOf(r.stderr);
  if (warnings.length === 0) return successResult(text, output);
  return successResult(`${text}\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`, {
    ...output,
    warnings,
  });
}
