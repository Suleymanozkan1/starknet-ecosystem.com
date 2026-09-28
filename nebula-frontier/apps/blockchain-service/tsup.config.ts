import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  // Bundle workspace packages (consumed as TS source); keep npm deps external.
  noExternal: [/^@nebula\//],
  external: ["@prisma/client", "@prisma/adapter-pg", "pg", "bullmq", "ioredis", "fastify", "@solana/kit"]
});
