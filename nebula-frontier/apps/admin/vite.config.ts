import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = process.env.VITE_DEV_API_PROXY ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true, host: true, proxy: { "/api": { target: API_TARGET, changeOrigin: false } } },
  preview: { port: 4174, proxy: { "/api": { target: API_TARGET, changeOrigin: false } } },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/recharts|d3-|victory|decimal\.js/.test(id)) return "vendor-charts";
          if (/react-dom|react-router|scheduler|[\\/]react[\\/]/.test(id)) return "vendor-react";
          return undefined;
        },
      },
    },
  },
});
