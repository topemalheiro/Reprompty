import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // Main process - bundle for production
        entry: resolve(__dirname, "src/main/index.ts"),
        onstart(options) {
          options.startup();
        },
        vite: {
          build: {
            outDir: resolve(__dirname, "dist/main"),
            minify: false,
            rollupOptions: {
              external: [
                "electron",
              ],
            },
          },
        },
      },
      {
        entry: resolve(__dirname, "src/preload/index.ts"),
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: resolve(__dirname, "dist/preload"),
            rollupOptions: {
              external: ["electron"],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
