import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { registerRoutes } from "./routes.js";
import { CMC_MODE } from "./cmc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "../../dist/web");

const app = express();
const PORT = Number(process.env.PORT) || 8787;

// Surface the data source (live | mock) to the browser on every response.
app.use((_req, res, next) => {
  res.setHeader("x-bedrock-mode", CMC_MODE);
  next();
});

registerRoutes(app);

// Serve the built site in production. In dev, Vite serves both pages on :5173
// instead. index.html is the marketing landing page; app.html is the
// data-explorer SPA, reachable at /app (its own state — tab, search, filters —
// lives in the query string, so this one route covers every deep link).
if (existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get("/app", (_req, res) => {
    res.sendFile(path.join(webDir, "app.html"));
  });
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ error: `Unknown endpoint: ${req.path}` });
      return;
    }
    res.sendFile(path.join(webDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`bedrock on http://localhost:${PORT}  ·  CMC mode: ${CMC_MODE}`);
  if (CMC_MODE === "mock") {
    console.log("  no CMC_API_KEY found — serving bundled fixtures. Add a key to .env for live data.");
  }
});
