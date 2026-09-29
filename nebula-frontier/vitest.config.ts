import { defineConfig } from "vitest/config";

/**
 * Two projects:
 *  - unit: pure logic, fully parallel.
 *  - integration: tests that start real servers (API, Colyseus) or use the shared PostgreSQL/Redis.
 *    They run one file at a time: on a small CI/dev box, parallel game servers + DB transactions starve
 *    each other (tick-timed assertions time out) and they share Redis keys (tickets, caches, queues).
 */
const INTEGRATION = [
  "tests/integration/**/*.test.ts",
  "apps/game-server/src/**/*.test.ts",
  "apps/blockchain-service/src/**/*.test.ts",
  "apps/api/src/**/*.test.ts",
  "packages/database/src/**/*.test.ts",
  "packages/**/src/**/*.db.test.ts",
];
const EXCLUDE = ["**/node_modules/**", "tools/reference-repos/**", "tests/e2e/**"];

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 120000,
    pool: "forks",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/*/src/**/*.test.ts"],
          exclude: [...EXCLUDE, ...INTEGRATION],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: INTEGRATION,
          exclude: EXCLUDE,
          fileParallelism: false,
        },
      },
    ],
  },
});
