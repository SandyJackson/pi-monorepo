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
import type { ErrorKind } from "./runner.ts";

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
export async function successResult(text: string, structured: Structured): Promise<KetchResult> {
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

export function warningsBlock(warnings: string[]): string {
  return warnings.length === 0 ? "" : `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`;
}
