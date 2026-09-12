import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CMC_BASE_URL || "https://pro-api.coinmarketcap.com";

/**
 * "live" when a key is present, otherwise "mock" — the server falls back to
 * bundled fixtures so the app runs before your hackathon key is issued.
 */
export const CMC_MODE: "live" | "mock" = process.env.CMC_API_KEY ? "live" : "mock";

/** Real World Assets endpoints, mapped to the fixture used in mock mode. */
const FIXTURES: Record<string, string> = {
  "/v5/real-world-assets/assets/list": "assets-list.json",
  "/v5/real-world-assets/quotes/latest": "quotes-latest.json",
  "/v5/real-world-assets/info": "info.json",
  "/v5/real-world-assets/map": "map.json",
  "/v5/real-world-assets/issuers/list": "issuers-list.json",
  "/v5/real-world-assets/issuers": "issuer.json",
  "/v5/real-world-assets/market-pairs/list": "market-pairs-list.json",
  "/v2/cryptocurrency/info": "crypto-info.json",
};

export class CmcError extends Error {
  statusCode: number;
  cmcStatus: unknown;
  constructor(message: string, statusCode: number, cmcStatus: unknown = null) {
    super(message);
    this.name = "CmcError";
    this.statusCode = statusCode;
    this.cmcStatus = cmcStatus;
  }
}

export async function cmcGet(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  if (CMC_MODE === "mock") {
    const file = FIXTURES[endpoint];
    if (!file) throw new CmcError(`No fixture for ${endpoint}`, 404);
    const raw = await readFile(path.resolve(here, "../../fixtures", file), "utf8");
    return JSON.parse(raw);
  }

  const url = new URL(BASE + endpoint);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: {
      "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY as string,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  // CMC returns error_code as a string ("0" on success) on the RWA endpoints and
  // as a number elsewhere — coerce before comparing.
  const errCode = Number(body?.status?.error_code);
  if (!res.ok || (Number.isFinite(errCode) && errCode !== 0)) {
    const message = body?.status?.error_message || res.statusText || "CMC request failed";
    throw new CmcError(`CMC ${res.status}: ${message}`, res.ok ? 502 : res.status, body?.status ?? null);
  }
  return body;
}
