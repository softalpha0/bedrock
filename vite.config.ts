import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The front end lives in src/web and builds to dist/web, which the Express
// server (src/server) serves in production. In dev, Vite serves the SPA and
// proxies /api to the running Express process.
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
