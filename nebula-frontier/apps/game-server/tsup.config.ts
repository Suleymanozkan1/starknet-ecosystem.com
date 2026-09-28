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
  banner: {
    // Some bundled CJS deps call require(); provide it in ESM output.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
