import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const API_TARGET = process.env.VITE_DEV_API_PROXY ?? "http://localhost:8080";

// Heavy dependencies are split so the landing/onboarding shell stays light:
// three.js (hangar + game), phaser (game HUD layer), solana web3 (wallet).
function manualChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  // GLTF/Draco/KTX2 loaders (production ship GLBs) load lazily with the world renderer.
  if (/[\\/]three[\\/]examples[\\/]jsm[\\/](loaders|libs|utils[\\/]SkeletonUtils)/.test(id)) return "vendor-three-gltf";
  if (/[\\/]three[\\/]/.test(id)) return "vendor-three";
  if (/[\\/]phaser[\\/]/.test(id)) return "vendor-phaser";
  if (/@colyseus|msgpackr/.test(id)) return "vendor-net";
  if (/@solana[\\/]web3\.js|@solana[\\/]wallet-adapter|@solana-mobile|@wallet-standard|bn\.js|borsh|jayson|rpc-websockets|superstruct|@noble/.test(id)) return "vendor-solana";
  if (/@capacitor|@aparajita/.test(id)) return "vendor-native";
  if (/react-dom|react-router|scheduler|[\\/]react[\\/]/.test(id)) return "vendor-react";
  return undefined;
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // @solana/web3.js expects Buffer (and a couple of node globals) in the browser.
    nodePolyfills({ include: ["buffer"], globals: { Buffer: true, global: true, process: false } }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false, ws: false },
    },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: API_TARGET, changeOrigin: false } },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: { output: { manualChunks } },
  },
});
