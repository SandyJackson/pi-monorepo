import { defineConfig } from "vitest/config";
import { TEST_EXCLUDES } from "./scripts/test-policy.ts";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: TEST_EXCLUDES,
  },
});
