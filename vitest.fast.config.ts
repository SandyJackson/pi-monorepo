import { mergeConfig } from "vitest/config";
import { SLOW_TEST_PATTERNS } from "./scripts/test-policy.ts";
import base from "./vitest.config.ts";

export default mergeConfig(base, {
  test: {
    exclude: SLOW_TEST_PATTERNS,
    maxWorkers: 4,
  },
});
