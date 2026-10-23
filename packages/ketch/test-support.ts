// Drives a ketch tool through its public `execute` with a fake process runner.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { vi } from "vitest";
import type { KetchDetails, KetchResult } from "./result.ts";
import type { Exec, ExecResult } from "./runner.ts";

export function ok(stdout: unknown, stderr = ""): ExecResult {
  return { stdout: JSON.stringify(stdout), stderr, code: 0, killed: false };
}

export function failed(code: number, stderr: string): ExecResult {
  return { stdout: "", stderr, code, killed: false };
}

export function setup<P extends TSchema>(
  create: (exec: Exec) => ToolDefinition<P, KetchDetails>,
  result: ExecResult | (() => Promise<ExecResult>),
) {
  const exec = vi.fn<Exec>(typeof result === "function" ? result : async () => result);
  const tool = create(exec);
  const run = (params: Parameters<typeof tool.execute>[1]) =>
    tool.execute("call", params, undefined, undefined, {} as never);
  const argv = () => exec.mock.calls[0]?.[1];
  const conforms = (r: KetchResult) => Value.Check(tool.outputSchema!, r.structuredContent);
  return { exec, run, argv, conforms };
}

export const text = (r: KetchResult) => (r.content[0] as { text: string }).text;
