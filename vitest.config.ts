import { defineConfig } from "vitest/config";
import { TEST_EXCLUDES } from "./scripts/test-policy.ts";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: TEST_EXCLUDES,
    setupFiles: ["./scripts/test-git-env.ts"],
    // Integration tests are CPU-bound subprocess trees; leave headroom for them.
    maxWorkers: "67%",
  },
});
