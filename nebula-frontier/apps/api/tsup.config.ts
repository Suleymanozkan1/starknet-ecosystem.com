import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Workspace packages are consumed as TS source and bundled; every npm dependency stays external
  // (resolved from node_modules at runtime, native addons like @node-rs/argon2 cannot be bundled).
  noExternal: [/^@nebula\//],
  skipNodeModulesBundle: true,
});
