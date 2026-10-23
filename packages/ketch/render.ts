// TUI cards for ketch calls. Display only: content and structuredContent are
// never changed, so the model and scripts keep the full result. Plain Text,
// not Markdown, keeps remote content inert. `safeText` and `preview` come from
// the ketch pi extension (1broseidon/ketch, plugins/pi/extensions/render.ts, MIT).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { KetchDetails, KetchResult } from "./result.ts";

type Row = Record<string, unknown>;

// How many results a collapsed card lists before "+N more".
const ROWS_SHOWN = 4;
// Arguments that name what the call acts on; the rest are shown as options.
const TARGETS = new Set(["query", "url", "urls"]);

// Terminal controls to strip, in order: OSC, DCS/PM/APC, CSI, other escapes,
// then C0/C1 controls (keeping tab and newline) and bidi overrides.
const CONTROLS = [
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls is the point
  /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls is the point
  /\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls is the point
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls is the point
  /\x1b[ -/]*[@-~]/g,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls is the point
  /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
];

/** Strips ANSI/OSC/DCS sequences, C0/C1 controls and invisible bidi overrides. */
export function safeText(value: unknown): string {
  return CONTROLS.reduce((text, pattern) => text.replace(pattern, ""), scalar(value));
}

/** One safe line of at most `limit` characters. */
export function preview(value: unknown, limit = 180): string {
  const text = safeText(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The call's target, then every other argument it set, in the order given. */
export function callSummary(args: unknown): string {
  const p = (args && typeof args === "object" ? args : {}) as Row;
  const urls = Array.isArray(p.urls) ? p.urls : [];
  const target = scalar(p.query) || scalar(p.url) || (urls.length ? `${urls.length} URLs` : "");
  const options = Object.entries(p).flatMap(([name, value]) => {
    if (TARGETS.has(name) || value === undefined || value === false) return [];
    const key = preview(name, 40);
    if (value === true) return [key];
    if (Array.isArray(value)) return [`${key}=${value.map(scalar).join(",")}`];
    return [`${key}=${preview(value, 50)}`];
  });
  return preview([target, ...options].filter(Boolean).join(" · "), 260);
}

/** A collapsed card: a count line, the first few results, then warnings. */
export function resultLines(result: KetchResult, isError = false): string[] {
  if (isError || result.isError) {
    return ["Failed", preview(contentText(result), 360) || "No error message returned"];
  }
  const data = (result.details?.result ?? {}) as Row;
  const [noun, rows] = Array.isArray(data.pages)
    ? ["page", data.pages]
    : Array.isArray(data.libraries)
      ? ["library", data.libraries]
      : ["result", Array.isArray(data.results) ? data.results : []];
  const plural = noun === "library" ? "libraries" : `${noun}s`;
  const lines = [`${rows.length} ${rows.length === 1 ? noun : plural}`];
  for (const [i, row] of rows.slice(0, ROWS_SHOWN).entries())
    lines.push(...rowLines(row as Row, i));
  if (rows.length > ROWS_SHOWN) lines.push(`   +${rows.length - ROWS_SHOWN} more`);
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  if (warnings.length) {
    lines.push(`${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`);
    for (const warning of warnings.slice(0, 2)) lines.push(`   ${preview(warning, 180)}`);
  }
  if (result.details?.fullOutputPath) {
    lines.push(
      `Truncated for the model; full output in ${preview(result.details.fullOutputPath, 160)}`,
    );
  }
  return lines;
}

function rowLines(row: Row, index: number): string[] {
  const where = row.repo
    ? `${scalar(row.repo)}/${scalar(row.path)}${row.line ? `:${scalar(row.line)}` : ""}`
    : "";
  const title = scalar(row.title) || where || scalar(row.id) || scalar(row.url) || "Untitled";
  const host = hostOf(row.url);
  const lines = [`${index + 1}. ${preview(title, 110)}${host ? ` · ${preview(host, 65)}` : ""}`];
  const id =
    scalar(row.library) || (row.id !== undefined && title !== row.id ? scalar(row.id) : "");
  if (id) lines.push(`   ${preview(id, 140)}`);
  const snippet = preview(
    scalar(row.description) || scalar(row.snippet) || scalar(row.markdown) || scalar(row.content),
    150,
  );
  if (snippet) lines.push(`   ${snippet}`);
  return lines;
}

/** Call and result renderers for one ketch command. */
export function renderers<P extends TSchema>(
  command: string,
): Pick<ToolDefinition<P, KetchDetails>, "renderCall" | "renderResult"> {
  return {
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`ketch ${command}`))} ${theme.fg("accent", callSummary(args))}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Working…"), 0, 0);
      const failed = Boolean(context?.isError || result.isError);
      const [first, ...rest] = resultLines(result, failed);
      const heading = theme.fg(failed ? "error" : "toolTitle", theme.bold(first));
      const body = rest
        .map((line) => (/^\d+\. /.test(line) ? theme.fg("text", line) : theme.fg("muted", line)))
        .join("\n");
      const extra = expanded
        ? safeText(contentText(result))
        : theme.fg("dim", "Expand tool output for full details");
      return new Text([heading, body, extra].filter(Boolean).join("\n"), 0, 0);
    },
  };
}

function contentText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function hostOf(url: unknown): string {
  try {
    return new URL(scalar(url)).hostname;
  } catch {
    return "";
  }
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
