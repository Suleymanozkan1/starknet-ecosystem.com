import { defineConfig } from "vite";
import { resolve } from "node:path";

const API_TARGET = process.env.VITE_API_PROXY ?? `http://localhost:${process.env.API_PORT ?? "8080"}`;

/**
 * App build of the standalone dev page (index.html → src/dev.ts) and the
 * renderer showcase (showcase.html → src/showcase.ts). The web app consumes
 * this package as TS source (`@nebula/game-client` → src/index.ts), so no
 * library bundle is required; three / phaser / colyseus are split into
 * long-cacheable vendor chunks.
 */
export default defineConfig({
  server: {
    port: 5175,
    proxy: { "/api": { target: API_TARGET, changeOrigin: true } },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        showcase: resolve(__dirname, "showcase.html"),
      },
      output: {
        manualChunks(id: string): string | undefined {
          if (id.includes("node_modules/three/examples")) return "three-addons";
          if (id.includes("node_modules/three/build/three.webgpu")) return "three-webgpu";
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("node_modules/phaser")) return "phaser";
          if (id.includes("node_modules/@colyseus") || id.includes("node_modules/msgpackr")) return "colyseus";
          if (id.includes("packages/config/data")) return "game-data";
          return undefined;
        },
      },
    },
  },
});
