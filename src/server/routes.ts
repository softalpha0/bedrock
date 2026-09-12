import type { Express, Request, Response } from "express";
import { cachedCmcGet } from "./cache.js";
import { CMC_MODE, CmcError } from "./cmc.js";

type Spec = { endpoint: string; params: string[] };

/**
 * Each app route is a thin, allow-listed proxy onto one CMC RWA endpoint.
 * The API key stays server-side; the browser only ever talks to /api/*.
 */
const ROUTES: Record<string, Spec> = {
  "/api/assets": {
    endpoint: "/v5/real-world-assets/assets/list",
    params: ["start", "limit", "convert"],
  },
  "/api/quotes": {
    endpoint: "/v5/real-world-assets/quotes/latest",
    params: ["rwa_id", "rwa_slug", "symbol", "convert"],
  },
  "/api/info": {
    endpoint: "/v5/real-world-assets/info",
    params: ["rwa_id", "rwa_slug", "symbol"],
  },
  "/api/map": {
    endpoint: "/v5/real-world-assets/map",
    params: ["start", "limit", "symbol"],
  },
  "/api/issuers": {
    endpoint: "/v5/real-world-assets/issuers/list",
    params: ["start", "limit"],
  },
  "/api/issuer": {
    endpoint: "/v5/real-world-assets/issuers",
    params: ["id", "slug", "issuer_id"],
  },
  "/api/market-pairs": {
    endpoint: "/v5/real-world-assets/market-pairs/list",
    params: ["rwa_id", "rwa_slug", "symbol", "start", "limit"],
  },
  // Standard (non-RWA) endpoint — resolves a backing token's crypto_id to its
  // CoinMarketCap page slug and chain (platform) for the detail view and the
  // Terminal's chain breakdown.
  "/api/crypto-info": {
    endpoint: "/v2/cryptocurrency/info",
    params: ["id", "slug", "symbol", "aux"],
  },
  // Account introspection — no RWA data, just this key's own plan/usage, shown
  // as a small transparency badge.
  "/api/usage": {
    endpoint: "/v1/key/info",
    params: [],
  },
};

export function registerRoutes(app: Express): void {
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, mode: CMC_MODE });
  });

  for (const [route, spec] of Object.entries(ROUTES)) {
    app.get(route, async (req: Request, res: Response) => {
      try {
        const params: Record<string, string> = {};
        for (const key of spec.params) {
          const value = req.query[key];
          if (typeof value === "string" && value !== "") params[key] = value;
        }
        const data = await cachedCmcGet(spec.endpoint, params);
        res.json(data);
      } catch (err) {
        const e = err as CmcError;
        res.status(e?.statusCode ?? 502).json({
          error: e?.message ?? "Upstream request failed",
          cmc_status: e?.cmcStatus ?? null,
        });
      }
    });
  }
}
