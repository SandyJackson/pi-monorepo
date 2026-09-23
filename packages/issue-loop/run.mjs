#!/usr/bin/env node
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major === 22 && minor >= 18) && major < 24) {
  console.error("issue-loop requires Node 22.18+ or Node 24+ for native TypeScript support.");
  process.exitCode = 1;
} else {
  await import("./cli.ts");
}
