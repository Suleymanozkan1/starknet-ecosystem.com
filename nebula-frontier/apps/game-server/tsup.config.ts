import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bots: "src/bots/cli.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle internal workspace packages (consumed as TS source); keep npm deps external.
  noExternal: [/^@nebula\//],
  // Every other bare import (incl. transitive deps of @nebula/* such as @node-rs/argon2,
  // @prisma/client, pg, jose) stays external and is resolved from node_modules at runtime.
  external: [/^(?!@nebula\/)(?![./])(?!node:)[@a-z]/],
  banner: {
    // Some bundled CJS deps call require(); provide it in ESM output.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
