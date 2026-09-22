import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { DELEGATED_TASK_FILE_FLAG, DELEGATED_TASK_PLACEHOLDER } from "./herdr/session.ts";

it("delivers the delegated task through Pi's real CLI startup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegated-task-startup-"));
  try {
    const task = "--review '世界' with sanitized spacing";
    const taskFile = path.join(directory, "task.md");
    const captureExtension = path.join(directory, "capture-input.ts");
    const capturedInputFile = path.join(directory, "input.json");
    fs.writeFileSync(taskFile, task, "utf8");
    // Runs after the subagent extension. Handling the input prevents any model request.
    fs.writeFileSync(
      captureExtension,
      `import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("input", (event) => {
    fs.writeFileSync(${JSON.stringify(capturedInputFile)}, JSON.stringify(event.text));
    return { action: "handled" };
  });
}
`,
      "utf8",
    );
    const cli = path.join(getPackageDir(), "dist", "cli.js");
    execFileSync(
      process.execPath,
      [
        cli,
        "--offline",
        "--no-approve",
        "--no-extensions",
        "-e",
        fileURLToPath(new URL("./index.ts", import.meta.url)),
        "-e",
        captureExtension,
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-session",
        "-p",
        `--${DELEGATED_TASK_FILE_FLAG}`,
        taskFile,
        DELEGATED_TASK_PLACEHOLDER,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: path.join(directory, "config"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
        },
        input: "",
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(JSON.parse(fs.readFileSync(capturedInputFile, "utf8"))).toBe(task);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
