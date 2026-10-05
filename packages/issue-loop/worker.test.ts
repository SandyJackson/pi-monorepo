import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EDITING_OUTCOME_EXAMPLES,
  parsePhaseOutcome,
  REVIEW_OUTCOME_EXAMPLES,
  runWorker,
} from "./worker.ts";

const root = mkdtempSync(join(tmpdir(), "loop-worker-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const peerScript = join(root, "peer.mjs");
writeFileSync(
  peerScript,
  `import { writeFileSync } from "node:fs";
const scenario = process.argv[2];
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const response = (id, data) => JSON.stringify({ id, type: "response", command: "prompt", success: true, data }) + "\\n";
let buffer = "";
function handle(command) {
  if (scenario === "handled") {
    out({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
    return;
  }
  if (scenario === "reject") {
    out({ id: command.id, type: "response", command: "prompt", success: false, error: "no model configured" });
    return;
  }
  const accepted = response(command.id, { disposition: "started" });
  if (scenario === "framing") {
    process.stdout.write(accepted.slice(0, 12));
    setTimeout(() => {
      process.stdout.write(accepted.slice(12));
      process.stdout.write(
        JSON.stringify({ type: "agent_start" }) + "\\n" +
        JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }) + "\\n",
      );
      const end = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "AUTHORITATIVE" }] } }) + "\\r\\n";
      process.stdout.write(end.slice(0, 24));
      setTimeout(() => {
        process.stdout.write(end.slice(24));
        out({ type: "agent_end", messages: [], willRetry: false });
        out({ type: "agent_settled" });
      }, 15);
    }, 15);
    return;
  }
  if (scenario === "wait-settled") {
    process.stdout.write(accepted);
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FIRST" }] } });
    out({ type: "agent_end", messages: [], willRetry: true });
    setTimeout(() => {
      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "SECOND" }] } });
      out({ type: "agent_settled" });
    }, 30);
    return;
  }
  if (scenario === "ignore-mismatched") {
    process.stdout.write(accepted);
    out({ type: "response", command: "get_state", id: "other", success: false, error: "ignore me" });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } });
    out({ type: "agent_settled" });
    return;
  }
  if (scenario === "malformed") {
    process.stdout.write(accepted);
    process.stdout.write("this is not json\\n");
    return;
  }
  if (scenario === "exit-early") {
    process.stdout.write(accepted);
    process.exit(0);
  }
  if (scenario === "error-message" || scenario === "aborted-message") {
    process.stdout.write(accepted);
    out({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: '{"outcome":"complete","summary":"Done."}' }],
        stopReason: scenario === "aborted-message" ? "aborted" : "error",
        ...(scenario === "error-message" ? { errorMessage: "provider stream failed" } : {}),
      },
    });
    out({ type: "agent_settled" });
    return;
  }
  if (scenario === "settled-stubborn") {
    process.stdout.write(accepted);
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } });
    out({ type: "agent_settled" });
    writeFileSync(process.cwd() + "/settled.pid", String(process.pid));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(accepted);
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled" });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\\n"); index !== -1; index = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`,
);

async function processGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function run(scenario: string, timeoutMs = 5_000) {
  return runWorker({
    executable: process.execPath,
    args: [peerScript, scenario],
    cwd: root,
    prompt: "Do the thing.",
    log: join(root, `${scenario}.log`),
    timeoutMs,
  });
}

it("frames partial, coalesced, and CRLF JSONL records", async () => {
  await expect(run("framing")).resolves.toEqual({ text: "AUTHORITATIVE" });
});

it("ignores responses for other command ids and waits for the settled run", async () => {
  await expect(run("wait-settled")).resolves.toEqual({ text: "SECOND" });
  await expect(run("ignore-mismatched")).resolves.toEqual({ text: "OK" });
});

it("rejects a handled prompt that started no run", async () => {
  await expect(run("handled")).rejects.toThrow(/handled the prompt without starting a run/);
});

it("rejects a refused prompt response", async () => {
  await expect(run("reject")).rejects.toThrow(/rejected the prompt: no model configured/);
});

it("rejects a malformed protocol record", async () => {
  await expect(run("malformed")).rejects.toThrow(/malformed JSON/);
});

it("rejects a process that exits before the run settles", async () => {
  await expect(run("exit-early")).rejects.toThrow(/before the run settled/);
});

it("rejects a settled run whose final message failed, even with valid outcome JSON", async () => {
  await expect(run("error-message")).rejects.toThrow(
    /unsuccessful response \(error: provider stream failed\)/,
  );
  await expect(run("aborted-message")).rejects.toThrow(/unsuccessful response \(aborted\)/);
});

it("bounds shutdown of a settled peer that ignores SIGTERM", async () => {
  const started = Date.now();
  await expect(
    runWorker({
      executable: process.execPath,
      args: [peerScript, "settled-stubborn"],
      cwd: root,
      prompt: "Do the thing.",
      log: join(root, "settled-stubborn.log"),
      timeoutMs: 5_000,
      settleGraceMs: 50,
      sigkillEscalationMs: 50,
    }),
  ).resolves.toEqual({ text: "DONE" });
  expect(Date.now() - started).toBeLessThan(2_000);
  const pid = Number(readFileSync(join(root, "settled.pid"), "utf8"));
  await expect(processGone(pid)).resolves.toBe(true);
});

describe("parsePhaseOutcome", () => {
  it("accepts a complete editing outcome", () => {
    expect(
      parsePhaseOutcome("editing", JSON.stringify({ outcome: "complete", summary: "Done." })),
    ).toEqual({ outcome: "complete", summary: "Done.", findings: [] });
  });

  it("accepts a passing review with structured findings", () => {
    const result = parsePhaseOutcome(
      "review",
      JSON.stringify({
        outcome: "pass",
        summary: "Looks good.",
        findings: [
          {
            axis: "standards",
            severity: "minor",
            location: "src/a.ts:1",
            description: "Rename this.",
          },
        ],
      }),
    );
    expect(result.findings).toEqual([
      {
        axis: "standards",
        severity: "minor",
        location: "src/a.ts:1",
        description: "Rename this.",
      },
    ]);
  });

  it("rejects editing outcomes that claim pass or carry findings", () => {
    expect(() =>
      parsePhaseOutcome("editing", JSON.stringify({ outcome: "pass", summary: "Done." })),
    ).toThrow(/outcome must be one of complete, incomplete, blocked/);
    expect(() =>
      parsePhaseOutcome(
        "editing",
        JSON.stringify({
          outcome: "complete",
          summary: "Done.",
          findings: [{ axis: "spec", severity: "major", location: "x", description: "Missing." }],
        }),
      ),
    ).toThrow(/editing outcomes cannot carry findings/);
  });

  it("rejects a review outcome that claims complete", () => {
    expect(() =>
      parsePhaseOutcome("review", JSON.stringify({ outcome: "complete", summary: "Done." })),
    ).toThrow(/outcome must be one of pass, changes_requested, incomplete, blocked/);
  });

  it("rejects a pass with material findings and a changes_requested without them", () => {
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "pass",
          summary: "Fine.",
          findings: [{ axis: "spec", severity: "major", location: "x", description: "Missing." }],
        }),
      ),
    ).toThrow(/pass cannot carry critical or major findings/);
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "changes_requested",
          summary: "Fix it.",
          findings: [{ axis: "spec", severity: "minor", location: "x", description: "Tidy." }],
        }),
      ),
    ).toThrow(/changes_requested must carry at least one critical or major finding/);
  });

  it("requires remainingWork for incomplete and blockers for blocked", () => {
    expect(() =>
      parsePhaseOutcome("editing", JSON.stringify({ outcome: "incomplete", summary: "Not done." })),
    ).toThrow(/incomplete outcomes must report remainingWork/);
    expect(
      parsePhaseOutcome(
        "editing",
        JSON.stringify({ outcome: "incomplete", summary: "Not done.", remainingWork: "Finish B." }),
      ),
    ).toMatchObject({ outcome: "incomplete", remainingWork: "Finish B." });
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({ outcome: "blocked", summary: "Stuck.", findings: [] }),
      ),
    ).toThrow(/blocked outcomes must report blockers/);
  });

  it("rejects a finding axis outside the advertised enum", () => {
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "pass",
          summary: "Fine.",
          findings: [{ axis: "style", severity: "minor", location: "x", description: "y" }],
        }),
      ),
    ).toThrow(/finding axis must be one of spec, standards/);
  });

  it("rejects malformed findings and unknown keys", () => {
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "pass",
          summary: "Fine.",
          findings: [{ axis: "spec", severity: "minor", location: "x", description: "y", id: 1 }],
        }),
      ),
    ).toThrow(/each finding must have exactly/);
    expect(() =>
      parsePhaseOutcome(
        "review",
        JSON.stringify({ outcome: "pass", summary: "Fine.", findings: [], extra: true }),
      ),
    ).toThrow(/unexpected key "extra"/);
  });

  it("rejects free text without a JSON object", () => {
    expect(() => parsePhaseOutcome("editing", "PASS, probably.")).toThrow(
      /Invalid editing outcome/,
    );
  });

  it("accepts every editing example the prompt advertises", () => {
    for (const { outcome, example } of EDITING_OUTCOME_EXAMPLES)
      expect(parsePhaseOutcome("editing", JSON.stringify(example)).outcome).toBe(outcome);
  });

  it("accepts every review example the prompt advertises", () => {
    for (const { outcome, example } of REVIEW_OUTCOME_EXAMPLES)
      expect(parsePhaseOutcome("review", JSON.stringify(example)).outcome).toBe(outcome);
  });

  it("parses a fenced object and preserves backticks inside JSON strings", () => {
    expect(
      parsePhaseOutcome(
        "editing",
        '```json\n{"outcome":"complete","summary":"Use ``` fences ``` in docs."}\n```',
      ),
    ).toMatchObject({ outcome: "complete", summary: "Use ``` fences ``` in docs." });
    expect(
      parsePhaseOutcome(
        "review",
        JSON.stringify({
          outcome: "pass",
          summary: "Fine.",
          findings: [
            {
              axis: "standards",
              severity: "minor",
              location: "a.md",
              description: "Wrap this:\n```\n# heading\n````\nCloses #1",
            },
          ],
        }),
      ).findings[0].description,
    ).toContain("````");
  });
});
