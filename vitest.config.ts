import { defineConfig } from "vitest/config";
import { TEST_EXCLUDES } from "./scripts/test-policy.ts";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: TEST_EXCLUDES,
    // Integration tests are CPU-bound subprocess trees; leave headroom for them.
    maxWorkers: "67%",
    maxConcurrency: 3,
  },
});
