import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { DELEGATED_TASK_FILE_FLAG, DELEGATED_TASK_PLACEHOLDER } from "./herdr/session.ts";

it.each([
  {
    name: "plain instruction",
    task: "--review '世界' with sanitized spacing",
  },
  {
    name: "expanded skill with single-line arguments",
    // The launcher flattens control characters before writing the task file.
    task: "/skill:delegated-startup mode=quick base=abc123 head=def456 spec=none label=世界",
  },
])(
  "delivers $name through Pi's real CLI startup",
  ({ task, name }) => {
    const directory = fs.mkdtempSync(
      fileURLToPath(new URL("./.delegated-task-startup-", import.meta.url)),
    );
    const fixtureSkill = fileURLToPath(
      new URL("./fixtures/delegated-startup/SKILL.md", import.meta.url),
    );
    try {
      const taskFile = path.join(directory, "task.md");
      const captureExtension = path.join(directory, "capture-input.ts");
      const capturedInputFile = path.join(directory, "input.json");
      fs.writeFileSync(taskFile, task, "utf8");
      // Capture after input transforms and skill expansion, then exit before any model request.
      fs.writeFileSync(
        captureExtension,
        `import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    fs.writeFileSync(${JSON.stringify(capturedInputFile)}, JSON.stringify(event.prompt));
    process.exit(0);
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
          "--skill",
          fixtureSkill,
          "--provider",
          "openai",
          "--model",
          "gpt-4o",
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
            OPENAI_API_KEY: "test-only-no-model-request",
            PI_CODING_AGENT_DIR: path.join(directory, "config"),
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
          },
          input: "",
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      const prompt = JSON.parse(fs.readFileSync(capturedInputFile, "utf8"));
      if (name === "plain instruction") {
        expect(prompt).toBe("--review '世界' with sanitized spacing");
      } else {
        expect(prompt).toBe(
          `<skill name="delegated-startup" location="${fixtureSkill}">\n` +
            `References are relative to ${path.dirname(fixtureSkill)}.\n\n` +
            "# Delegated startup fixture\n\n" +
            "Return the supplied key=value arguments verbatim on one line.\n" +
            "</skill>\n\n" +
            "mode=quick base=abc123 head=def456 spec=none label=世界",
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
