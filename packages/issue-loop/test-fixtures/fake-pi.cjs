const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (args.includes("--version")) {
  console.log(process.env.FIXTURE_PI_VERSION || "0.99.2");
  process.exit(0);
}
const name = value("--name") || "";
const session = value("--session");
// Session files are the conversation history a real Pi process reloads on restart.
function readSessionRecords() {
  if (!fs.existsSync(session)) return [];
  return fs
    .readFileSync(session, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function appendSessionRecord(record) {
  fs.appendFileSync(session, `${JSON.stringify(record)}\n`);
}
const out = (record) => {
  if (record.type === "message_end")
    appendSessionRecord({ type: "message", message: record.message });
  process.stdout.write(`${JSON.stringify(record)}\n`);
};
const isParentReview = () => name.includes("parent review");
let promptCount = 0;
function materialSeverity(body) {
  const lower = String(body || "").toLowerCase();
  if (lower.includes("[critical]")) return "critical";
  if (lower.includes("[major]")) return "major";
  return "minor";
}
function reviewOutcome() {
  const mode = process.env.FIXTURE_MODE;
  if (mode === "malformed") return "PASS, probably.";
  if (mode === "legacy-review") return JSON.stringify({ verdict: "pass", findings: [] });
  if (mode === "review-incomplete")
    return JSON.stringify({
      outcome: "incomplete",
      summary: "Not finished reviewing.",
      findings: [],
      remainingWork: "Need more evidence.",
    });
  if (mode === "reject" || (mode === "parent-reject" && isParentReview()))
    return JSON.stringify({
      outcome: "changes_requested",
      summary: "Missing acceptance criterion",
      findings: [
        {
          axis: "spec",
          severity: "major",
          location: "feature.txt",
          description: "Missing acceptance criterion",
        },
      ],
    });
  if (mode === "blocked-review")
    return JSON.stringify({
      outcome: "blocked",
      summary: "Cannot assess required behavior",
      findings: [],
      blockers: "Missing required environment",
    });
  if (mode === "pass-body") {
    const body = process.env.FIXTURE_REVIEW_BODY || "";
    const severity = materialSeverity(body);
    return JSON.stringify({
      outcome: "pass",
      summary: "Looks good.",
      findings: body ? [{ axis: "spec", severity, location: "review", description: body }] : [],
    });
  }
  if (mode === "pass-notes" || mode === "comment-create-fail") {
    const note = isParentReview()
      ? process.env.FIXTURE_REVIEW_BODY || "[Standards][Minor] Parent cleanup"
      : "[Spec][Minor] Ticket cleanup";
    return JSON.stringify({
      outcome: "pass",
      summary: "Review passed.",
      findings: [{ axis: "spec", severity: "minor", location: "review", description: note }],
    });
  }
  return JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] });
}
function implementOutcome() {
  const mode = process.env.FIXTURE_MODE;
  if (mode === "editing-pass") return JSON.stringify({ outcome: "pass", summary: "Done." });
  if (mode === "editing-incomplete")
    return JSON.stringify({
      outcome: "incomplete",
      summary: "Still working.",
      remainingWork: "Finish the parser.",
    });
  if (mode === "editing-blocked")
    return JSON.stringify({
      outcome: "blocked",
      summary: "Stuck.",
      blockers: "Missing credentials.",
    });
  return JSON.stringify({ outcome: "complete", summary: "Implemented the requested ticket." });
}
function handle(command) {
  const prompt = command.message;
  const historyBefore = readSessionRecords();
  if (!fs.existsSync(session)) appendSessionRecord({ type: "session_info", name });
  fs.appendFileSync(
    path.join(process.env.FIXTURE_ROOT, "workers.jsonl"),
    `${JSON.stringify({ name, session, args, prompt, cwd: process.cwd(), historyBefore })}\n`,
  );
  if (command.type === "prompt")
    appendSessionRecord({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    });
  const isImplement = name.includes("implement");
  const isEditing = name.includes("implement") || name.includes("repair");
  const mode = process.env.FIXTURE_MODE;
  if (isParentReview())
    fs.writeFileSync(
      path.join(process.env.FIXTURE_ROOT, "parent-review-order.txt"),
      fs.existsSync(path.join(process.env.FIXTURE_ROOT, "pr.json")) ? "after-pr" : "before-pr",
    );
  if (
    (mode === "fail-parent-review" || mode === "fail-parent-review-comment-fail") &&
    isParentReview() &&
    command.type === "prompt"
  ) {
    console.error("Provider unavailable");
    process.exit(1);
  }
  if (mode === "hold-parent-review" && isParentReview() && command.type === "prompt") {
    // Signal that the parent review is running, then wait until the controller interrupts it.
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    fs.writeFileSync(path.join(process.env.FIXTURE_ROOT, "parent-review-ready"), "ready\n");
    return;
  }
  if (mode === "parent-review-index-mutation" && isParentReview() && command.type === "prompt") {
    // Only the index changes: HEAD and the working files stay as published.
    require("node:child_process").execFileSync("git", ["read-tree", "HEAD^"], {
      cwd: process.cwd(),
    });
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: reviewOutcome() }] },
    });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (command.type === "steer") {
    out({
      id: command.id,
      type: "response",
      command: "steer",
      success: true,
      data: { disposition: "queued" },
    });
    return;
  }
  if (command.type === "clear_queue") {
    out({
      id: command.id,
      type: "response",
      command: "clear_queue",
      success: true,
      data: { steering: [], followUp: [] },
    });
    return;
  }
  if (command.type === "abort") {
    out({ id: command.id, type: "response", command: "abort", success: true });
    process.exit(0);
  }
  if (command.type === "prompt") promptCount++;
  if (mode === "integrated") {
    // One scripted run through recovery, repair/audit, hook repair, and manual work.
    const reply = (events) => {
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      for (const event of events) out(event);
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
    };
    const answer = (text) =>
      reply([
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } },
      ]);
    const pass = JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] });
    const changes = (description) =>
      JSON.stringify({
        outcome: "changes_requested",
        summary: description,
        findings: [{ axis: "spec", severity: "major", location: "feature.txt", description }],
      });
    const count = (key) => {
      const file = path.join(process.env.FIXTURE_ROOT, `integrated-${key}`);
      const next = (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0) + 1;
      fs.writeFileSync(file, String(next));
      return next;
    };
    if (name.includes("#11 implement")) {
      if (promptCount === 1)
        return reply([
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "provider failed" }],
              stopReason: "error",
              errorMessage: "529 overloaded",
            },
          },
          {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 10,
            errorMessage: "529 overloaded",
          },
          { type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" },
        ]);
      fs.writeFileSync("feature.txt", "implemented\n");
      return answer(implementOutcome());
    }
    if (name.includes("#11 review"))
      return answer(count("review-11") === 1 ? changes("INTEGRATED_11 finding") : pass);
    if (name.includes("#11 repair")) {
      fs.writeFileSync("fix-11.txt", "fixed\n");
      return answer(implementOutcome());
    }
    if (name.includes("#12 implement")) {
      fs.writeFileSync("ticket-12.txt", "implemented\n");
      return answer(implementOutcome());
    }
    if (name.includes("#12 repair")) {
      if (!fs.existsSync("hook-fixed.txt")) {
        fs.writeFileSync("hook-fixed.txt", "fixed\n");
        return answer(implementOutcome());
      }
      console.error("Provider unavailable");
      process.exit(1);
    }
    if (name.includes("#12 review")) {
      const reviewCount = count("review-12");
      if (reviewCount === 1) return answer(changes("INTEGRATED_12 finding"));
      // Second child review: capture the reviewed patch now, before the advisory
      // parent review overwrites the shared review.patch.
      const match = command.message.match(/Patch including new files: (.+)/);
      const patchPath = match ? match[1].trim() : "";
      const patch = patchPath && fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
      fs.writeFileSync(
        path.join(process.env.FIXTURE_ROOT, "integrated-manual-review.patch"),
        patch,
      );
      if (!patch.includes("manual-12.txt") || !patch.includes("Manually fixed")) {
        return answer(
          JSON.stringify({
            outcome: "changes_requested",
            summary: "Reviewed patch omits the manual fix",
            findings: [
              {
                axis: "spec",
                severity: "major",
                location: "manual-12.txt",
                description: "The reviewed patch is missing manual-12.txt or its content",
              },
            ],
          }),
        );
      }
      return answer(pass);
    }
    if (isParentReview())
      return answer(
        JSON.stringify({
          outcome: "pass",
          summary: "Parent review passed.",
          findings: [
            {
              axis: "standards",
              severity: "minor",
              location: "review",
              description: "[Standards][Minor] Parent cleanup",
            },
          ],
        }),
      );
    return answer(pass);
  }
  if (
    isImplement &&
    (mode === "recover-transient" || mode === "recover-exhausted" || mode === "recover-correction")
  ) {
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    if (mode === "recover-correction" && promptCount === 1) {
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PASS, probably." }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    if (mode === "recover-exhausted" || (mode === "recover-transient" && promptCount === 1)) {
      out({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "provider failed" }],
          stopReason: "error",
          errorMessage: "529 overloaded",
        },
      });
      out({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: "529 overloaded",
      });
      out({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    fs.writeFileSync("feature.txt", "implemented\n");
    out({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: implementOutcome() }] },
    });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "repair-check") {
    if (isEditing) {
      if (name.includes("repair")) fs.writeFileSync("check-ok", "ok");
      else fs.writeFileSync("feature.txt", "implemented\n");
    }
    const text = isEditing ? implementOutcome() : reviewOutcome();
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "retraction") {
    if (isEditing && !name.includes("repair")) fs.writeFileSync("feature.txt", "implemented\n");
    let text;
    if (isEditing) {
      text = name.includes("repair")
        ? JSON.stringify({
            outcome: "complete",
            summary:
              "The finding is mistaken: feature.txt already satisfies the requirement, so no change was made.",
          })
        : implementOutcome();
    } else if (name.includes("review")) {
      const counterFile = path.join(process.env.FIXTURE_ROOT, "retraction-review-count");
      const count =
        (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
      fs.writeFileSync(counterFile, String(count));
      text =
        count === 1
          ? JSON.stringify({
              outcome: "changes_requested",
              summary: "Suspected missing behavior",
              findings: [
                {
                  axis: "spec",
                  severity: "major",
                  location: "feature.txt",
                  description: "Suspected missing behavior",
                },
              ],
            })
          : JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] });
    } else {
      text = reviewOutcome();
    }
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "two-failures") {
    if (isEditing) {
      if (fs.existsSync("second.txt")) fs.writeFileSync("third.txt", "third");
      else if (fs.existsSync("first.txt")) fs.writeFileSync("second.txt", "second");
      else fs.writeFileSync("first.txt", "first");
    }
    let text;
    if (isEditing) {
      text = implementOutcome();
    } else if (name.includes("review")) {
      const counterFile = path.join(process.env.FIXTURE_ROOT, "two-failures-count");
      const count =
        (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
      fs.writeFileSync(counterFile, String(count));
      text =
        count === 1
          ? JSON.stringify({
              outcome: "changes_requested",
              summary: "First failure",
              findings: [
                {
                  axis: "spec",
                  severity: "major",
                  location: "first.txt",
                  description: "FIRST_FAILURE finding",
                },
              ],
            })
          : count === 2
            ? JSON.stringify({
                outcome: "changes_requested",
                summary: "Second failure",
                findings: [
                  {
                    axis: "spec",
                    severity: "major",
                    location: "second.txt",
                    description: "SECOND_FAILURE finding",
                  },
                ],
              })
            : JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] });
    } else {
      text = reviewOutcome();
    }
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "manual-repair") {
    if (isEditing) {
      if (name.includes("repair")) {
        console.error("Provider unavailable");
        process.exit(1);
      }
      fs.writeFileSync("feature.txt", "implemented\n");
      const text = implementOutcome();
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    const text = JSON.stringify({
      outcome: "changes_requested",
      summary: "Repair the failing behavior",
      findings: [
        {
          axis: "spec",
          severity: "major",
          location: "feature.txt",
          description: "INTERRUPTED_REPAIR finding",
        },
      ],
    });
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "manual-repair-check") {
    if (isEditing) {
      if (name.includes("repair")) {
        fs.writeFileSync("feature.txt", "implemented\n");
        fs.writeFileSync("check-ok", "ok");
      } else fs.writeFileSync("feature.txt", "implemented\n");
      const text = implementOutcome();
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    const text =
      name.includes("audit") || fs.existsSync("check-ok")
        ? JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] })
        : JSON.stringify({
            outcome: "changes_requested",
            summary: "Checks still fail",
            findings: [
              {
                axis: "spec",
                severity: "major",
                location: "check-ok",
                description: "CHECKS_FAILING finding",
              },
            ],
          });
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "manual-review") {
    if (isEditing) {
      fs.writeFileSync("feature.txt", "implemented\n");
      const text = implementOutcome();
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    console.error("Provider unavailable");
    process.exit(1);
  }
  if (mode === "manual-audit-check") {
    if (isEditing) {
      if (name.includes("repair")) {
        console.error("Provider unavailable");
        process.exit(1);
      }
      fs.writeFileSync("feature.txt", "implemented\n");
      const text = implementOutcome();
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    if (name.includes("audit")) {
      const auditFile = path.join(process.env.FIXTURE_ROOT, "manual-audit-count");
      const auditCount =
        (fs.existsSync(auditFile) ? Number(fs.readFileSync(auditFile, "utf8")) : 0) + 1;
      fs.writeFileSync(auditFile, String(auditCount));
      if (auditCount === 1) {
        console.error("Provider unavailable");
        process.exit(1);
      }
      const auditText = JSON.stringify({ outcome: "pass", summary: "Audit passed.", findings: [] });
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: auditText }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    const counterFile = path.join(process.env.FIXTURE_ROOT, "manual-audit-review-count");
    const count =
      (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
    fs.writeFileSync(counterFile, String(count));
    const text =
      count === 1
        ? JSON.stringify({
            outcome: "changes_requested",
            summary: "Fix the first attempt",
            findings: [
              {
                axis: "spec",
                severity: "major",
                location: "feature.txt",
                description: "FIRST_FAILURE finding",
              },
            ],
          })
        : JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] });
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "repair-partial-fail" || mode === "repair-partial-files-fail") {
    if (isEditing) {
      if (name.includes("repair")) {
        if (fs.existsSync("repair-partial.txt")) {
          fs.writeFileSync("fixed.txt", "fixed\n");
          const text = implementOutcome();
          out({
            id: command.id,
            type: "response",
            command: "prompt",
            success: true,
            data: { disposition: "started" },
          });
          out({ type: "agent_start" });
          out({ type: "message_start", message: { role: "assistant", content: [] } });
          out({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text }] },
          });
          out({ type: "agent_end", messages: [], willRetry: false });
          out({ type: "agent_settled" });
          return;
        }
        fs.writeFileSync("repair-partial.txt", "partial\n");
        if (mode === "repair-partial-files-fail")
          fs.writeFileSync("repair-extra.txt", "extra partial\n");
        console.error("Provider unavailable");
        process.exit(1);
      }
      fs.writeFileSync("feature.txt", "implemented\n");
      const text = implementOutcome();
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    const text = fs.existsSync("fixed.txt")
      ? JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] })
      : JSON.stringify({
          outcome: "changes_requested",
          summary: "Repair required",
          findings: [
            {
              axis: "spec",
              severity: "major",
              location: "repair-partial.txt",
              description: "INCOMPLETE_REPAIR finding",
            },
          ],
        });
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "stale-failure") {
    if (isEditing) {
      if (name.includes("repair")) fs.writeFileSync("fixed.txt", "fixed");
      else fs.writeFileSync("feature.txt", "implemented\n");
      const text = implementOutcome();
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    if (name.includes("audit")) {
      const text = JSON.stringify({
        outcome: "blocked",
        summary: "Audit cannot run",
        findings: [],
        blockers: "Transient audit failure",
      });
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    const counterFile = path.join(process.env.FIXTURE_ROOT, "stale-failure-review-count");
    const count =
      (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
    fs.writeFileSync(counterFile, String(count));
    const text =
      count === 1
        ? JSON.stringify({
            outcome: "changes_requested",
            summary: "First failure",
            findings: [
              {
                axis: "spec",
                severity: "major",
                location: "feature.txt",
                description: "STALE_FAILURE finding",
              },
            ],
          })
        : JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] });
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "fixup") {
    if (isEditing) {
      if (fs.existsSync("first.txt")) fs.writeFileSync("second.txt", "second");
      else fs.writeFileSync("first.txt", "first");
    }
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    let text;
    if (isEditing) text = implementOutcome();
    else if (isParentReview())
      text = JSON.stringify({ outcome: "pass", summary: "Parent review passed.", findings: [] });
    else {
      const counterFile = path.join(process.env.FIXTURE_ROOT, "fixup-review-count");
      const count =
        (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
      fs.writeFileSync(counterFile, String(count));
      text =
        count === 1
          ? JSON.stringify({
              outcome: "changes_requested",
              summary: "Fix the first attempt",
              findings: [
                {
                  axis: "spec",
                  severity: "major",
                  location: "first.txt",
                  description: "Fix the first attempt",
                },
              ],
            })
          : JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] });
    }
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "hook-repair") {
    if (isEditing) {
      if (name.includes("repair")) fs.writeFileSync("hook-fixed.txt", "fixed");
      else fs.writeFileSync("feature.txt", "implemented\n");
    }
    const text = isEditing ? implementOutcome() : reviewOutcome();
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "hook-mutation-repair") {
    if (isEditing) {
      if (name.includes("repair")) fs.writeFileSync("feature.txt", "repaired\n");
      else fs.writeFileSync("feature.txt", "implemented\n");
    }
    const text = isEditing ? implementOutcome() : reviewOutcome();
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "noop") {
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    const text = isEditing ? implementOutcome() : reviewOutcome();
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "review-edit" && !isEditing) {
    fs.appendFileSync(path.join(process.cwd(), "feature.txt"), "tampered");
    const text = JSON.stringify({ outcome: "pass", summary: "Review passed.", findings: [] });
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "agent_end", messages: [], willRetry: false });
    out({ type: "agent_settled" });
    return;
  }
  if (mode === "stall-review" && !isEditing) {
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "tool_execution_start", toolCallId: "review-stall", toolName: "bash", args: {} });
    return;
  }
  if (mode === "stall-implement" && isEditing) {
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({
      type: "tool_execution_start",
      toolCallId: "implement-stall",
      toolName: "bash",
      args: {},
    });
    return;
  }
  if (mode === "stall-after-write" && isEditing) {
    fs.writeFileSync("feature.txt", "partial\n");
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({
      type: "tool_execution_start",
      toolCallId: "implement-stall",
      toolName: "bash",
      args: {},
    });
    return;
  }
  if (mode === "stall-once" && !isEditing) {
    const counterFile = path.join(process.env.FIXTURE_ROOT, "review-count");
    const count =
      (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
    fs.writeFileSync(counterFile, String(count));
    if (count === 1) {
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({ type: "tool_execution_start", toolCallId: "review-stall", toolName: "bash", args: {} });
      return;
    }
    if (count === 2) {
      const text = JSON.stringify({
        outcome: "changes_requested",
        summary: "Fix the review finding",
        findings: [
          {
            axis: "spec",
            severity: "major",
            location: "feature.txt",
            description: "Fix the review finding",
          },
        ],
      });
      out({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "assistant", content: [] } });
      out({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      out({ type: "agent_end", messages: [], willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
  }
  if (mode === "fail-review-after-delay" && !isEditing) {
    out({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    setTimeout(() => {
      console.error("Provider unavailable");
      process.exit(1);
    }, 300);
    return;
  }
  if (isEditing) {
    if (mode === "signal-exit") process.kill(process.pid, "SIGTERM");
    if (mode === "replace-lock") {
      const lock = path.join(path.dirname(path.dirname(session)), "run.lock");
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, "new-owner\n");
    }
    if (mode === "missing-lock" || mode === "directory-lock") {
      const lock = path.join(path.dirname(path.dirname(session)), "run.lock");
      fs.unlinkSync(lock);
      if (mode === "directory-lock") fs.mkdirSync(lock);
      console.error("Provider unavailable");
      process.exit(1);
    }
    if (mode === "unicode-error") {
      const output = Buffer.from("Provider says café");
      const split = output.indexOf(Buffer.from("é"));
      process.stderr.write(output.subarray(0, split + 1));
      setTimeout(() => {
        process.stderr.write(output.subarray(split + 1), () => process.exit(1));
      }, 50);
      return;
    }
    if (mode === "stubborn") {
      process.on("SIGTERM", () => {});
      fs.writeFileSync(path.join(process.env.FIXTURE_ROOT, "stubborn.pid"), String(process.pid));
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === "commit-fail") {
      require("node:child_process").execFileSync("git", [
        "commit",
        "--allow-empty",
        "-m",
        "Unauthorized worker commit",
      ]);
      process.exit(1);
    }
    if (mode === "fail") {
      console.error("Provider unavailable");
      process.exit(1);
    }
    if (mode === "write-then-fail") {
      fs.writeFileSync("feature.txt", "partial\n");
      console.error("Provider unavailable");
      process.exit(1);
    }
    fs.writeFileSync("feature.txt", "implemented\n");
  }
  const text = isEditing ? implementOutcome() : reviewOutcome();
  out({
    id: command.id,
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition: "started" },
  });
  out({ type: "agent_start" });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled" });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  process.exitCode = 0;
});
