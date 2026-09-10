import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Makes real, authenticated calls to the CoinMarketCap RWA API and writes the
 * raw responses to evidence/ — this is the "visible evidence of a real API
 * call" the hackathon submission asks for.
 *
 *   npm run verify
 */

const KEY = process.env.CMC_API_KEY;
const BASE = process.env.CMC_BASE_URL || "https://pro-api.coinmarketcap.com";

if (!KEY) {
  console.error("CMC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const CALLS = [
  {
    name: "assets-list",
    path: "/v5/real-world-assets/assets/list",
    query: { start: "1", limit: "10", convert: "USD" },
  },
  {
    name: "issuers-list",
    path: "/v5/real-world-assets/issuers/list",
    query: { start: "1", limit: "10" },
  },
  {
    name: "quotes-latest",
    path: "/v5/real-world-assets/quotes/latest",
    query: { rwa_id: "1", convert: "USD" },
  },
  {
    name: "info",
    path: "/v5/real-world-assets/info",
    query: { rwa_id: "1" },
  },
];

const out: string[] = [];
const log = (line = "") => {
  console.log(line);
  out.push(line);
};

await mkdir("evidence", { recursive: true });
log(`CoinMarketCap RWA API — verification run ${new Date().toISOString()}`);
log(`Base URL: ${BASE}`);
log(`Auth header: X-CMC_PRO_API_KEY: ****${KEY.slice(-4)}`);
log("");

let failures = 0;

for (const call of CALLS) {
  const url = new URL(BASE + call.path);
  for (const [k, v] of Object.entries(call.query)) url.searchParams.set(k, v);

  log(`GET ${url.pathname}${url.search}`);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "X-CMC_PRO_API_KEY": KEY, Accept: "application/json" },
    });
    const body: any = await res.json();
    const ms = Date.now() - startedAt;

    log(`  HTTP ${res.status} in ${ms}ms`);
    log(`  status: ${JSON.stringify(body?.status)}`);

    const record =
      body?.data?.rwa_assets?.[0] ??
      body?.data?.issuers?.[0] ??
      (Array.isArray(body?.data) ? body.data[0] : undefined) ??
      body?.data;
    log("  first record:");
    log(
      String(JSON.stringify(record, null, 2) ?? "undefined")
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );

    await writeFile(`evidence/${call.name}.json`, JSON.stringify(body, null, 2));
    log(`  saved -> evidence/${call.name}.json`);
    if (!res.ok || Number(body?.status?.error_code) > 0) failures++;
  } catch (err) {
    failures++;
    log(`  request failed: ${(err as Error).message}`);
  }
  log("");
}

await writeFile("evidence/verify-output.txt", out.join("\n") + "\n");
log("Wrote evidence/verify-output.txt — review it, then commit a sanitised copy for your submission.");
process.exit(failures ? 1 : 0);
