import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("./src/web", import.meta.url));

// The front end lives in src/web and builds to dist/web, which the Express
// server (src/server) serves in production. In dev, Vite serves both pages and
// proxies /api to the running Express process.
//
// Two entry points: index.html is the marketing landing page, app.html is the
// data-explorer SPA (served by Express at the /app route).
export default defineConfig({
  root: webRoot,
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: `${webRoot}/index.html`,
        app: `${webRoot}/app.html`,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
