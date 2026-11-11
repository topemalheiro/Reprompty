import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";
import { resolve } from "node:path";

// vite-plugin-electron starts Electron with this environment; with the variable set it would run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

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
            emptyOutDir: true,
            minify: false,
            rollupOptions: {
              external: [
                "electron",
                "ws",
                "bufferutil",
                "utf-8-validate",
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
            emptyOutDir: true,
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
