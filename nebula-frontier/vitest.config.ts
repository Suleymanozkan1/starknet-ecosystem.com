import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts", "scripts/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tools/reference-repos/**", "tests/e2e/**"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "forks"
  }
});
