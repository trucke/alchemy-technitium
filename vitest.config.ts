import { defineConfig } from "vitest/config";

// Offline tests only. The provider's lifecycle tests need a Technitium server; see
// vitest.server.config.ts.
export default defineConfig({
  test: {
    include: [
      "packages/technitium/test/**/*.test.ts",
      "packages/alchemy-technitium/test/unit/**/*.test.ts",
    ],
  },
});
