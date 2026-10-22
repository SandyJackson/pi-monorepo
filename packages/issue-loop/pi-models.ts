import { statSync } from "node:fs";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { command } from "./process.ts";
import type { LoopSettings } from "./settings.ts";

/** Shared by preflight and workers so ambient providers cannot mask missing extensions. */
export async function workerExtensionArgs(settings: LoopSettings): Promise<string[]> {
  const manager = new DefaultPackageManager({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.inMemory(),
  });
  const args = ["--no-extensions", "--no-mcp", "--extension", "builtin:codemode"];
  for (const { path } of settings.extensions ?? []) {
    const resources = await manager.resolveExtensionSources([path]);
    const entries = resources.extensions.filter((entry) => entry.enabled);
    if (entries.length === 0 || entries.some((entry) => !statSync(entry.path).isFile()))
      throw new Error(`Loop extension ${path} must resolve to extension files`);
    // Passing a package directory to -e also loads its skills, prompts and themes.
    for (const entry of entries) args.push("--extension", entry.path);
  }
  return args;
}

/** Resolve models without sending a prompt or calling a provider. */
export async function assertWorkerModels(settings: LoopSettings, cwd: string): Promise<void> {
  for (const extension of settings.extensions ?? []) {
    try {
      const stat = statSync(extension.path);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("not a file or directory");
    } catch (error) {
      throw new Error(
        `Cannot load loop extension ${extension.path}: ${error instanceof Error ? error.message : String(error)}; restore it before resuming`,
      );
    }
  }
  const extensionArgs = await workerExtensionArgs(settings);
  // Repairs inherit an implementation or review conversation's model.
  const checked = new Set<string | undefined>();
  for (const role of ["implement", "review", "describe"] as const) {
    const model = settings[role].model;
    if (checked.has(model)) continue;
    const args = [
      "--mode",
      "rpc",
      "--approve",
      "--no-session",
      "--no-skills",
      "--offline",
      ...extensionArgs,
      ...(model ? ["--model", model] : []),
    ];
    try {
      const output = await command("pi", args, {
        cwd,
        timeoutMs: 30_000,
        input: `${JSON.stringify({ type: "get_state", id: "preflight" })}\n`,
      });
      const response = output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((record) => record.type === "response" && record.id === "preflight");
      if (!response?.success || !response.data?.model)
        throw new Error(response?.error ?? "Pi did not resolve a model");
    } catch (error) {
      throw new Error(
        `Pi model preflight failed for ${role} (${model ?? "Pi default"}). Ambient extensions are disabled; configure required provider paths in --settings "extensions". Loaded extensions: ${(settings.extensions ?? []).map(({ path }) => path).join(", ") || "none"}.\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
    checked.add(model);
  }
}
