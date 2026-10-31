import { defineConfig } from "vitest/config";

// Lifecycle tests against a throwaway Technitium server in a local container (docs/TESTING.md).
export default defineConfig({
  test: {
    include: ["packages/alchemy-technitium/test/server/**/*.test.ts"],
    globalSetup: ["packages/alchemy-technitium/test/server/globalSetup.ts"],
    // One server, shared by every test file: run them one after another.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
